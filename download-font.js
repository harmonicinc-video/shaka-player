const https = require('https');
const fs = require('fs');

const url = 'https://fonts.googleapis.com/icon?family=Material+Icons+Round';
const outputPath = './material-icons.css';

https.get(url, (res) => {
  if (res.statusCode !== 200) {
    console.error(`Failed to get '${url}'. Status code: ${res.statusCode}`);
    res.resume(); // Consume response data to free up memory
    return;
  }

  const fileStream = fs.createWriteStream(outputPath);
  res.pipe(fileStream);

  fileStream.on('finish', () => {
    fileStream.close();
    console.log(`Downloaded and saved to ${outputPath}`);
  });
}).on('error', (err) => {
  console.error(`Error: ${err.message}`);
});


