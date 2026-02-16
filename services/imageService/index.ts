import { IImageService } from './IImageService.js';
import { WikidataImageService } from './WikidataImageService.js';

// Wikidata is the default (no API keys needed)
export const imageService: IImageService = new WikidataImageService();
