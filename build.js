// build.js - Using existing Netlify environment variables
const fs = require('fs');
require('dotenv').config();

console.log('Starting build process with existing Netlify environment variables...');

// Check for environment variables
const envVars = {
  apiKey: process.env.apiKey || '',
  authDomain: process.env.authDomain || '',
  projectId: process.env.projectId || '',
  storageBucket: process.env.storageBucket || '',
  messagingSenderId: process.env.messagingSenderId || '',
  appId: process.env.appId || '',
  measurementId: process.env.measurementId || '',
  // Add Claude API key
  claudeApiKey: process.env.VITE_LLM_API_KEY || ''
};

// Log environment variable status (without revealing full values)
console.log('Environment variables check:');
Object.keys(envVars).forEach(key => {
  const value = envVars[key];
  const isSet = value && value.length > 0;
  console.log(`- ${key}: ${isSet ? 'Set ✓' : 'Not set ✗'}`);
});

// Create a direct config.js file with the values
const configContent = `
// Auto-generated Firebase configuration
window.firebaseConfig = {
  apiKey: "${envVars.apiKey}",
  authDomain: "infoseccompliance-chat.firebaseapp.com",
  projectId: "${envVars.projectId}",
  storageBucket: "${envVars.storageBucket}",
  messagingSenderId: "${envVars.messagingSenderId}",
  appId: "${envVars.appId}",
  measurementId: "${envVars.measurementId || ''}"
};

// Claude API configuration
window.claudeConfig = {
  apiKey: "${envVars.claudeApiKey}"
};

console.log("Firebase config loaded from environment variables");
console.log("Claude API config loaded from environment variables");
`;

// Write the config file
fs.writeFileSync('config.js', configContent);
console.log('Generated config.js with Firebase and Claude API configurations');

console.log('Build completed successfully!'); 