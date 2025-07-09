const less = require('less');
const fs = require('fs');

// Read the LESS file
const lessContent = fs.readFileSync('./ui/controls.less', 'utf8');

// Configure LESS with custom HTTP options
const options = {
  timeout: 30000,  // 30 second timeout
  strictMath: false,
  javascriptEnabled: false,
  compress: false,
  // Custom HTTP agent configuration
  httpOptions: {
    timeout: 30000,
    keepAlive: true,
    maxSockets: 10
  }
};

console.log('Starting LESS compilation with extended timeout...');

less.render(lessContent, options)
  .then((result) => {
    console.log('✅ LESS compilation successful!');
    console.log('Output length:', result.css.length);
    // Write output to file for inspection
    fs.writeFileSync('./debug-output.css', result.css);
  })
  .catch((error) => {
    console.error('❌ LESS compilation failed:');
    console.error('Error type:', error.constructor.name);
    console.error('Error message:', error.message);
    console.error('Full error:', error);
  });
