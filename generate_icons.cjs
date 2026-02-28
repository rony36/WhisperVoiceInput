const { createCanvas } = require('canvas');
const fs = require('fs');
const path = require('path');

const sizes = [16, 32, 48, 128];
const outDir = path.join(__dirname, 'public', 'assets', 'icons');

// Ensure directory exists
if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
}

sizes.forEach(size => {
    const canvas = createCanvas(size, size);
    const ctx = canvas.getContext('2d');
    
    const scale = size / 128; // Base design on 128x128
    
    // 1. Background: Dark rounded rect
    ctx.fillStyle = '#1e1e1e';
    ctx.beginPath();
    ctx.roundRect(0, 0, size, size, 24 * scale);
    ctx.fill();
    
    // 2. Microphone Body: Pill shape
    ctx.fillStyle = '#28cd41'; // Bright green
    const micWidth = 32 * scale;
    const micHeight = 60 * scale;
    const micX = (size - micWidth) / 2;
    const micY = 24 * scale;
    ctx.beginPath();
    ctx.roundRect(micX, micY, micWidth, micHeight, micWidth / 2);
    ctx.fill();
    
    // 3. Microphone Stand/Ring
    ctx.strokeStyle = '#28cd41';
    ctx.lineWidth = 10 * scale;
    ctx.lineCap = 'round';
    ctx.beginPath();
    // Arc around bottom
    ctx.arc(size / 2, micY + micHeight - (micWidth/2), micWidth / 2 + 16 * scale, 0, Math.PI, false);
    ctx.stroke();
    
    // Base line
    ctx.beginPath();
    ctx.moveTo(size / 2, micY + micHeight + 10 * scale);
    ctx.lineTo(size / 2, size - 16 * scale);
    ctx.stroke();
    
    // Write to file
    const buffer = canvas.toBuffer('image/png');
    fs.writeFileSync(path.join(outDir, `icon${size}.png`), buffer);
    console.log(`Generated icon${size}.png`);
});
