require('fs').writeFileSync('.env.test', 'KEY="value"');
process.loadEnvFile('.env.test');
console.log(process.env.KEY);
