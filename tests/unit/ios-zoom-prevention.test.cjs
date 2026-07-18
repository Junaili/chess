const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');

test('the app viewport prevents accidental page zoom', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const viewport = html.match(/<meta name="viewport" content="([^"]+)" \/>/)?.[1] ?? '';

  assert.match(viewport, /minimum-scale=1(?:\.0)?/);
  assert.match(viewport, /maximum-scale=1(?:\.0)?/);
  assert.match(viewport, /user-scalable=no/);
});

test('the iOS shell disables WKWebView pinch zoom', () => {
  const appDelegate = fs.readFileSync(
    path.join(root, 'ios/App/App/AppDelegate.swift'),
    'utf8'
  );

  assert.match(appDelegate, /minimumZoomScale\s*=\s*1/);
  assert.match(appDelegate, /maximumZoomScale\s*=\s*1/);
  assert.match(appDelegate, /pinchGestureRecognizer\?\.isEnabled\s*=\s*false/);
});
