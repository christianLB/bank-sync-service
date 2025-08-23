const { Configuration, MessagesApi } = require('@k2600x/comm-service-sdk');

const api = new MessagesApi(new Configuration({
  basePath: 'http://192.168.1.11:8080/api',
  accessToken: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzZXJ2aWNlIjoiZ29jYXJkbGVzcy1zZXJ2aWNlIiwicGVybWlzc2lvbnMiOlsibWVzc2FnZXM6c2VuZCIsIm5vdGlmaWNhdGlvbnM6dGVsZWdyYW0iLCJldmVudHM6cHVibGlzaCJdLCJ0eXBlIjoic2VydmljZSIsImlhdCI6MTc1NTk3NjI3NSwiYXVkIjpbImNvbW0tc2VydmljZSJdLCJpc3MiOiJjb21tLXNlcnZpY2UifQ.8YYo-AKlGaUlrDLVmNiYXC0EiBtMV9v4MEqSQrw4XnA'
}));

async function testNotification() {
  try {
    console.log('Testing comm service notification...');
    
    const result = await api.v1MessagesSendPost({
      channel: 'telegram',
      template_key: 'test',
      locale: 'en',
      data: {
        title: 'Test from Bank Sync',
        body: 'Testing notification system'
      },
      to: {}
    });
    
    console.log('Success:', result);
  } catch (error) {
    console.error('Error:', error.message);
    console.error('Response:', error.response?.data);
  }
}

testNotification();