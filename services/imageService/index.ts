import { config } from '../../config/index.js';
import { IImageService } from './IImageService.js';
import { WikidataImageService } from './WikidataImageService.js';
import { PexelsImageService } from './PexelsImageService.js';
import logger from '../../utils/logger.js';

function createImageService(): IImageService {
    const provider = config.imageService.provider;

    logger.info(`Initializing image service: ${provider}`);

    if (provider === 'pexels') {
        if (!config.pexels.apiKey) {
            logger.warn('Pexels API key not configured, falling back to Wikidata');
            return new WikidataImageService(config.wikidata.coordinateToleranceKm);
        }
        // Initialize Pexels with Wikidata fallback
        const wikidataFallback = new WikidataImageService(config.wikidata.coordinateToleranceKm);
        return new PexelsImageService(config.pexels.apiKey, wikidataFallback);
    }

    // Default to Wikidata
    return new WikidataImageService(config.wikidata.coordinateToleranceKm);
}

export const imageService = createImageService();
