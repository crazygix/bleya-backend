const WIKIDATA_SPARQL_ENDPOINT = 'https://query.wikidata.org/sparql';
const DEFAULT_TIMEOUT_MS = 12_000;

const MIN_RADIUS_KM = 1;
const MAX_RADIUS_KM = 300;
const MIN_LIMIT = 1;
const MAX_LIMIT = 50;

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

SELECT ?city ?cityLabel ?countryLabel ?coord ?image ?distance WHERE {
  SERVICE wikibase:around {
    ?city wdt:P625 ?coord .
    bd:serviceParam wikibase:center "Point(${longitude} ${latitude})"^^geo:wktLiteral .
    bd:serviceParam wikibase:radius "${radiusKm}" .
    bd:serviceParam wikibase:distance ?distance .
  }

  # Only city entities (exclude towns/villages)
  ?city wdt:P31/wdt:P279* wd:Q515 .
  OPTIONAL { ?city wdt:P1082 ?population . }
  FILTER(!BOUND(?population) || ?population >= 20000)

  OPTIONAL { ?city wdt:P17 ?country . }
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
        const uniqueCities = new Map<string, DiscoveredCity>();

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
            const name = country.length > 0 ? `${cityLabel}, ${country}` : cityLabel;

            uniqueCities.set(`wikidata:${cityId}`, {
                cityKey: `wikidata:${cityId}`,
                name,
                imageUrl,
                latitude: coordinates.latitude,
                longitude: coordinates.longitude,
                distanceKm: Number.isFinite(distanceKm) ? distanceKm : 0,
            });
        }

        return Array.from(uniqueCities.values())
            .sort((a, b) => a.distanceKm - b.distanceKm)
            .slice(0, limit);
    } finally {
        clearTimeout(timeout);
    }
}
