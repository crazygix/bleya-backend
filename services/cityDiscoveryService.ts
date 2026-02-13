
// Actually I should copy the VALID content from the previous view_file to be safe about imports.
// The view_file Step 575 shows everything. I will copy-paste that and ensure it's correct.

const WIKIDATA_SPARQL_ENDPOINT = 'https://query.wikidata.org/sparql';
const DEFAULT_TIMEOUT_MS = 12_000;

const MIN_RADIUS_KM = 1;
const MAX_RADIUS_KM = 300;
const MIN_LIMIT = 1;
const MAX_LIMIT = 100;

interface WikidataBindingValue {
    type: string;
    value: string;
}

interface WikidataBinding {
    city?: WikidataBindingValue;
    cityLabel?: WikidataBindingValue;
    countryLabel?: WikidataBindingValue;
    coord?: WikidataBindingValue;
    image?: WikidataBindingValue;
    distance?: WikidataBindingValue;
    population?: WikidataBindingValue;
}

interface WikidataSparqlResponse {
    results?: {
        bindings?: WikidataBinding[];
    };
}

export interface CityDiscoveryInput {
    latitude: number;
    longitude: number;
    radiusKm: number;
    limit: number;
}

export interface DiscoveredCity {
    cityKey: string;
    name: string;
    imageUrl: string;
    latitude: number;
    longitude: number;
    distanceKm: number;
}

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

function parseEntityId(entityUri: string): string | null {
    const match = entityUri.match(/\/(Q\d+)$/i);
    if (!match) {
        return null;
    }

    return match[1].toLowerCase();
}

function parseWktPoint(value: string): { longitude: number; latitude: number } | null {
    const match = value.match(/^Point\((-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)\)$/);
    if (!match) {
        return null;
    }

    const longitude = Number.parseFloat(match[1]);
    const latitude = Number.parseFloat(match[2]);

    if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) {
        return null;
    }

    if (longitude < -180 || longitude > 180 || latitude < -90 || latitude > 90) {
        return null;
    }

    return { longitude, latitude };
}

function buildNearbyCitiesQuery(latitude: number, longitude: number, radiusKm: number, limit: number): string {
    return `
PREFIX geo: <http://www.opengis.net/ont/geosparql#>

SELECT ?city ?cityLabel ?countryLabel ?coord ?image ?distance ?population WHERE {
  SERVICE wikibase:around {
    ?city wdt:P625 ?coord .
    bd:serviceParam wikibase:center "Point(${longitude} ${latitude})"^^geo:wktLiteral .
    bd:serviceParam wikibase:radius "${radiusKm}" .
    bd:serviceParam wikibase:distance ?distance .
  }

  # Only city entities (exclude towns/villages)
  ?city wdt:P31/wdt:P279* wd:Q515 .
  OPTIONAL { ?city wdt:P1082 ?population . }
  FILTER(BOUND(?population) && ?population >= 20000)

  # Exclude historical/dissolved entities
  FILTER NOT EXISTS { ?city wdt:P576 ?dissolved }
  FILTER NOT EXISTS { ?city wdt:P582 ?endTime }

  # Exclude archaeological sites, ruins, and historical cities
  FILTER NOT EXISTS { ?city wdt:P31/wdt:P279* wd:Q839954 }
  FILTER NOT EXISTS { ?city wdt:P31/wdt:P279* wd:Q120560 }
  FILTER NOT EXISTS { ?city wdt:P31/wdt:P279* wd:Q3024240 }
  FILTER NOT EXISTS { ?city wdt:P31/wdt:P279* wd:Q34442 }

  # Get country (REQUIRED) and ensure it is current
  ?city wdt:P17 ?country .
  FILTER NOT EXISTS { ?country wdt:P582 ?countryEnd }
  FILTER NOT EXISTS { ?country wdt:P576 ?countryDissolved }
  OPTIONAL { ?city wdt:P18 ?image . }

  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}
ORDER BY ?distance
LIMIT ${limit}
`.trim();
}

export async function discoverNearbyCities(input: CityDiscoveryInput): Promise<DiscoveredCity[]> {
    const latitude = Number(input.latitude.toFixed(6));
    const longitude = Number(input.longitude.toFixed(6));
    const radiusKm = Number(clamp(input.radiusKm, MIN_RADIUS_KM, MAX_RADIUS_KM).toFixed(2));
    const limit = Math.trunc(clamp(input.limit, MIN_LIMIT, MAX_LIMIT));

    // Fetch data from Wikidata
    const query = buildNearbyCitiesQuery(latitude, longitude, radiusKm, limit);

    const searchParams = new URLSearchParams({
        query,
        format: 'json',
    });

    const url = `${WIKIDATA_SPARQL_ENDPOINT}?${searchParams.toString()}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

    try {
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                Accept: 'application/sparql-results+json',
                'User-Agent': 'bleya-backend/1.0 (city-room-discovery)',
            },
            signal: controller.signal,
        });

        if (!response.ok) {
            throw new Error(`Wikidata request failed with ${response.status}`);
        }

        const payload = await response.json() as WikidataSparqlResponse;
        const bindings = payload.results?.bindings ?? [];
        const cities: DiscoveredCity[] = [];

        for (const binding of bindings) {
            const entityUri = binding.city?.value;
            const cityLabel = binding.cityLabel?.value;
            const coordValue = binding.coord?.value;

            if (!entityUri || !cityLabel || !coordValue) {
                continue;
            }

            const cityId = parseEntityId(entityUri);
            if (!cityId) {
                continue;
            }

            const coordinates = parseWktPoint(coordValue);
            if (!coordinates) {
                continue;
            }

            const country = binding.countryLabel?.value?.trim() || '';
            const imageUrl = binding.image?.value || '';
            const distanceKm = Number.parseFloat(binding.distance?.value || '0');
            // We don't need population for clustering anymore, but good to have if we want to sort or filter later.
            // For now, adhere to interface.

            const name = country.length > 0 ? `${cityLabel}, ${country}` : cityLabel;

            cities.push({
                cityKey: `wikidata:${cityId}`,
                name,
                imageUrl,
                latitude: coordinates.latitude,
                longitude: coordinates.longitude,
                distanceKm: Number.isFinite(distanceKm) ? distanceKm : 0,
            });
        }

        return cities
            .sort((a, b) => a.distanceKm - b.distanceKm);

    } finally {
        clearTimeout(timeout);
    }
}



// Helper for Haversine distance
function distanceInKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 6371; // Radius of the earth in km
    const dLat = deg2rad(lat2 - lat1);
    const dLon = deg2rad(lon2 - lon1);
    const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(deg2rad(lat1)) * Math.cos(deg2rad(lat2)) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

function deg2rad(deg: number): number {
    return deg * (Math.PI / 180);
}
