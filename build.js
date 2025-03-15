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
  measurementId: process.env.measurementId || ''
};

// Log environment variable status (without revealing full values)
console.log('Environment variables check:');
Object.keys(envVars).forEach(key => {
  const value = envVars[key];
  const isSet = value && value.length > 0;
  console.log(`- ${key}: ${isSet ? 'Set ✓' : 'Not set ✗'}`);
});

// Create a config.js file with the environment variables
const configContent = `
// Generated config file with environment variables
window.firebaseConfig = {
  apiKey: "${envVars.apiKey}",
  authDomain: "${envVars.authDomain}",
  projectId: "${envVars.projectId}",
  storageBucket: "${envVars.storageBucket}",
  messagingSenderId: "${envVars.messagingSenderId}",
  appId: "${envVars.appId}",
  measurementId: "${envVars.measurementId}"
};

console.log("Firebase config loaded from environment variables");
`;

// Write the config file
fs.writeFileSync('config.js', configContent);
console.log('Generated config.js file with environment variables');

console.log('Build completed successfully!'); 