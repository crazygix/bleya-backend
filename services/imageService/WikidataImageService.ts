import { IImageService, ImageSearchResult, CityImageQuery } from './IImageService.js';
import { config } from '../../config/index.js';
import logger from '../../utils/logger.js';

interface WikidataBinding {
    city?: { value: string };
    cityLabel?: { value: string };
    image?: { value: string };
    coord?: { value: string };
}

interface WikidataResponse {
    results?: {
        bindings?: WikidataBinding[];
    };
}

export class WikidataImageService implements IImageService {
    private readonly sparqlEndpoint = config.wikidata.sparqlEndpoint;
    private readonly toleranceKm = config.wikidata.coordinateToleranceKm;

    async searchCityImage(query: CityImageQuery): Promise<ImageSearchResult | null> {
        const sparqlQuery = this.buildSparqlQuery(query);

        try {
            const response = await fetch(
                `${this.sparqlEndpoint}?query=${encodeURIComponent(sparqlQuery)}&format=json`,
                {
                    headers: {
                        Accept: 'application/sparql-results+json',
                        'User-Agent': 'bleya-backend/1.0',
                    },
                }
            );

            if (!response.ok) {
                logger.warn(`Wikidata query failed: ${response.status}`);
                return null;
            }

            const data: WikidataResponse = await response.json();
            const bindings = data.results?.bindings || [];

            // Filter results by name similarity and coordinates
            const match = this.findBestMatch(bindings, query);

            if (!match?.image?.value) {
                return null;
            }

            // Convert Wikimedia Commons URL to direct image URL
            const imageUrl = this.getWikimediaImageUrl(match.image.value);

            return {
                url: imageUrl,
                thumbnailUrl: imageUrl, // Wikimedia serves responsive images
            };
        } catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            logger.error('Wikidata image search failed', { error: err.message, stack: err.stack });
            return null;
        }
    }

    private buildSparqlQuery(query: CityImageQuery): string {
        const { latitude, longitude } = query;

        return `
      SELECT ?city ?cityLabel ?image ?coord WHERE {
        SERVICE wikibase:around {
          ?city wdt:P625 ?coord.
          bd:serviceParam wikibase:center "Point(${longitude} ${latitude})"^^geo:wktLiteral.
          bd:serviceParam wikibase:radius "${this.toleranceKm}".
        }
        
        # Must be a city
        ?city wdt:P31/wdt:P279* wd:Q515.
        
        # Must have an image
        ?city wdt:P18 ?image.
        
        # Get label
        SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
      }
      LIMIT 10
    `.trim();
    }

    private findBestMatch(
        bindings: WikidataBinding[],
        query: CityImageQuery
    ): WikidataBinding | null {
        if (bindings.length === 0) return null;

        const normalizedQueryName = this.normalizeName(query.name);
        const nameMatches: WikidataBinding[] = [];

        // Step 1: Find all name matches
        for (const binding of bindings) {
            const cityLabel = binding.cityLabel?.value;
            if (!cityLabel) continue;

            const normalizedLabel = this.normalizeName(cityLabel);

            // Check for name match (exact or contains)
            if (
                normalizedLabel === normalizedQueryName ||
                normalizedLabel.includes(normalizedQueryName) ||
                normalizedQueryName.includes(normalizedLabel)
            ) {
                nameMatches.push(binding);
            }
        }

        // Step 2: If we have name matches, pick the closest one by coordinates
        if (nameMatches.length > 0) {
            return this.findClosestByCoordinates(nameMatches, query);
        }

        // Step 3: No name matches - fall back to closest by location
        return this.findClosestByCoordinates(bindings, query);
    }

    private findClosestByCoordinates(
        bindings: WikidataBinding[],
        query: CityImageQuery
    ): WikidataBinding | null {
        // Wikidata already sorts by distance (from SPARQL query)
        // So the first result is the closest
        return bindings[0] || null;
    }

    private normalizeName(name: string): string {
        return name
            .toLowerCase()
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '') // Remove diacritics
            .replace(/[^a-z0-9]/g, '');
    }

    private getWikimediaImageUrl(commonsUrl: string): string {
        // Extract filename from Commons URL
        // Example: http://commons.wikimedia.org/wiki/Special:FilePath/Paris_-_Eiffelturm.jpg
        // Already returns a direct image URL
        return commonsUrl;
    }
}
