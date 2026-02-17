import { IImageService, CityImageQuery, ImageSearchResult } from './IImageService.js';
import logger from '../../utils/logger.js';

interface PexelsPhoto {
    id: number;
    width: number;
    height: number;
    url: string;
    photographer: string;
    photographer_url: string;
    photographer_id: number;
    avg_color: string;
    src: {
        original: string;
        large2x: string;
        large: string;
        medium: string;
        small: string;
        portrait: string;
        landscape: string;
        tiny: string;
    };
    liked: boolean;
    alt: string;
}

interface PexelsSearchResponse {
    page: number;
    per_page: number;
    photos: PexelsPhoto[];
    total_results: number;
    next_page?: string;
}

export class PexelsImageService implements IImageService {
    private readonly apiKey: string;
    private readonly apiUrl = 'https://api.pexels.com/v1/search';

    private readonly fallbackService?: IImageService;

    constructor(apiKey: string, fallbackService?: IImageService) {
        if (!apiKey) {
            throw new Error('Pexels API key is required');
        }
        this.apiKey = apiKey;
        this.fallbackService = fallbackService;
    }

    async searchCityImage(query: CityImageQuery): Promise<ImageSearchResult | null> {
        const searchQueries = [
            `${query.name} ${query.countryName} cityscape landmark fortress river downtown center`
        ];

        logger.info(`Searching Pexels for: ${query.name} (${query.countryName})`);

        for (const searchQuery of searchQueries) {
            try {
                const result = await this.searchPhotos(searchQuery, query.name);
                if (result) {
                    logger.info(`Found Pexels image for ${query.name} with query: "${searchQuery}"`);
                    return result;
                }
            } catch (error) {
                logger.warn(`Pexels search failed for query "${searchQuery}"`, { error });
            }
        }

        logger.warn(`No Pexels image found for ${query.name}`);

        if (this.fallbackService) {
            logger.info(`Falling back to ${this.fallbackService.constructor.name} for ${query.name}`);
            return this.fallbackService.searchCityImage(query);
        }

        return null;
    }

    private async searchPhotos(searchQuery: string, originalCityName: string): Promise<ImageSearchResult | null> {
        const url = new URL(this.apiUrl);
        url.searchParams.append('query', searchQuery);
        url.searchParams.append('per_page', '15'); // Fetch more to allow filtering/randomization
        url.searchParams.append('orientation', 'landscape');

        try {
            const response = await fetch(url.toString(), {
                headers: {
                    Authorization: this.apiKey,
                },
            });

            if (!response.ok) {
                logger.warn(`Pexels API error: ${response.status} ${response.statusText}`);
                return null;
            }

            const data: PexelsSearchResponse = await response.json();

            if (!data.photos || data.photos.length === 0) {
                return null;
            }

            // Filter out photos that don't match the city name in description/alt (basic verification)
            // This helps avoid generic "city" results for unknown places
            const usefulPhotos = data.photos.filter(photo => {
                const text = (photo.alt || '').toLowerCase();
                const name = originalCityName.toLowerCase();
                return text.includes(name);
            });

            // If we have verified photos, pick a random one from top 3 to avoid always getting the same "best" image
            // If no verified photos, fall back to any photo if query included country (riskier but better than nothing)
            let candidates = usefulPhotos.length > 0 ? usefulPhotos : data.photos;

            // If the query was very specific (city + country), we can trust the results more
            // verification is crucial if we used a generic query, but here we removed generic `${query.name} city`

            // Select the highest rated/most relevant photo (first one)
            // This aligns with "best light" request by trusting Pexels ranking
            const photo = candidates[0];

            return {
                url: photo.src.large2x, // High quality image
                thumbnailUrl: photo.src.medium,
            };
        } catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            logger.error('Pexels API request failed', { error: err.message, stack: err.stack });
            return null;
        }
    }
}
