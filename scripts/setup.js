import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import readline from 'readline';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

const question = (query) => new Promise((resolve) => rl.question(query, resolve));

async function setup() {
    console.log('Setting up environment variables...\n');

    const envPath = path.join(__dirname, '..', '.env');

    // Check if .env already exists
    if (fs.existsSync(envPath)) {
        const answer = await question('.env file already exists. Do you want to overwrite it? (y/N): ');
        if (answer.toLowerCase() !== 'y') {
            console.log('Setup cancelled.');
            rl.close();
            return;
        }
    }

    // Get MongoDB URI
    const mongoUri = await question('Enter MongoDB URI (default: mongodb://localhost:27017/bleya): ') || 'mongodb://localhost:27017/bleya';

    // Get server configuration
    const port = await question('Enter server port (default: 8080): ') || '8080';
    const clientUri = await question('Enter client URI (default: http://localhost:8080): ') || 'http://localhost:8080';

    // Get JWT secret
    const jwtSecret = await question('Enter JWT secret (default: supersecret): ') || 'supersecret';

    // Create .env content
    const envContent = `
# Database Configuration
MONGODB_URI=${mongoUri}

# Server Configuration
PORT=${port}
NODE_ENV=development
CLIENT_URI=${clientUri}

# JWT Secret
JWT_SECRET=${jwtSecret}
`;

    // Write to .env file
    fs.writeFileSync(envPath, envContent.trim() + '\n');
    console.log('\n.env file created successfully!');

    rl.close();
}

setup().catch(console.error); 