import test from 'node:test';
import assert from 'node:assert/strict';

import { getApiBase } from '../js/config.js';

test('uses the current origin for LAN and Tailscale direct access', () => {
    assert.equal(
        getApiBase('192.168.1.20', {
            protocol: 'http:',
            hostname: '192.168.1.20',
            origin: 'http://192.168.1.20:5005',
        }),
        'http://192.168.1.20:5005',
    );
    assert.equal(
        getApiBase('100.91.167.48', {
            protocol: 'http:',
            hostname: '100.91.167.48',
            origin: 'http://100.91.167.48:5005',
        }),
        'http://100.91.167.48:5005',
    );
});

test('keeps Funnel and VPS HTTPS requests on their same origin', () => {
    assert.equal(
        getApiBase('station.example.ts.net', {
            protocol: 'https:',
            hostname: 'station.example.ts.net',
            origin: 'https://station.example.ts.net',
        }),
        'https://station.example.ts.net',
    );
    assert.equal(
        getApiBase('music.example.com', {
            protocol: 'https:',
            hostname: 'music.example.com',
            origin: 'https://music.example.com',
        }),
        'https://music.example.com',
    );
});

test('uses the configured Station port for an explicit remote host', () => {
    assert.equal(
        getApiBase('100.64.0.9', {
            protocol: 'http:',
            hostname: 'localhost',
            origin: 'http://localhost:5173',
        }),
        'http://100.64.0.9:5005',
    );
});
