// Simple fucking test that works
console.log('Testing Hello Fucking World notification...');

const https = require('http');
const data = JSON.stringify({
  message: 'Hello Fucking World - Direct API Test'
});

const options = {
  hostname: '192.168.1.11',
  port: 4010,
  path: '/v1/notifications/test',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': data.length
  }
};

const req = https.request(options, (res) => {
  let responseData = '';
  
  res.on('data', (chunk) => {
    responseData += chunk;
  });
  
  res.on('end', () => {
    console.log('Response:', JSON.parse(responseData));
    console.log('🎉 HELLO FUCKING WORLD NOTIFICATION SENT!');
  });
});

req.on('error', (error) => {
  console.error('Error:', error);
});

req.write(data);
req.end();