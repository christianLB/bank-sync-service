const { Configuration, MessagesApi } = require('@k2600x/comm-service-sdk');

const api = new MessagesApi(new Configuration({
  basePath: 'http://192.168.1.11:8080',
  accessToken: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzZXJ2aWNlIjoiYmFuay1zeW5jLXNlcnZpY2UiLCJwZXJtaXNzaW9ucyI6WyJtZXNzYWdlczpzZW5kIiwibm90aWZpY2F0aW9uczp0ZWxlZ3JhbSIsImV2ZW50czpwdWJsaXNoIl0sInR5cGUiOiJzZXJ2aWNlIiwiaWF0IjoxNzU2MDQwNzMyLCJhdWQiOlsiY29tbS1zZXJ2aWNlIiwidHJhZGluZy1zZXJ2aWNlIwiZmluYW5jaWFsLXNlcnZpY2UiLCJhaS1zZXJ2aWNlIiwibWVtb3J5LXNlcnZpY2UiLCJnb2NhcmRsZXNzLXNlcnZpY2UiLCJ0ZXN0LXNlcnZpY2UiLCJiYW5rLXN5bmMtc2VydmljZSJdLCJpc3MiOiJjb21tLXNlcnZpY2UifQ.ADisIlWJFaOS_z-1zy2mXNG95IE6l_AW8ZUs0KkAcTs'
}));

async function testNotification() {
  try {
    console.log('Testing comm service notification...');
    
    const result = await api.v1MessagesSendPost({
      channel: 'telegram',
      template_key: 'test',
      locale: 'en',
      data: {
        title: 'Hello Fucking World',
        body: 'Notification test working perfectly'
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