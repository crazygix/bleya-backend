import { config } from '../../config/index.js';
import { IImageService } from './IImageService.js';
import { WikidataImageService } from './WikidataImageService.js';
import { PexelsImageService } from './PexelsImageService.js';
import logger from '../../utils/logger.js';

export function createImageService(provider = config.imageService.provider): IImageService {
    logger.info(`Initializing image service: ${provider}`);

    if (provider === 'pexels') {
        if (!config.pexels.apiKey) {
            logger.warn('Pexels API key not configured, falling back to Wikidata');
            return new WikidataImageService(config.wikidata.coordinateToleranceKm);
        }

        const wikidataFallback = new WikidataImageService(config.wikidata.coordinateToleranceKm);
        return new PexelsImageService(config.pexels.apiKey, wikidataFallback);
    }

    return new WikidataImageService(config.wikidata.coordinateToleranceKm);
}

let imageServiceInstance: IImageService | null = null;

export function getImageService(): IImageService {
    if (!imageServiceInstance) {
        imageServiceInstance = createImageService();
    }

    return imageServiceInstance;
}

export function setImageServiceForTests(service: IImageService | null): void {
    imageServiceInstance = service;
}
