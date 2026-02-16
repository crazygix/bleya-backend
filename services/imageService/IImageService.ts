export interface ImageSearchResult {
    url: string;
    thumbnailUrl?: string;
}

export interface CityImageQuery {
    name: string;
    country: string;
    countryName: string;
    latitude: number;
    longitude: number;
}

export interface IImageService {
    searchCityImage(query: CityImageQuery): Promise<ImageSearchResult | null>;
}
