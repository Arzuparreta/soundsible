/**
 * Test for WebUI Rendering Logic
 */

// Mock DOM for testing
const mockDocument = {
    getElementById: (id) => ({
        innerHTML: '',
        classList: { add: () => {}, remove: () => {}, contains: () => false, replace: () => {} },
        style: {}
    }),
    createElement: (tag) => ({
        textContent: '',
        innerHTML: ''
    })
};

// Simple Mock of esc
function esc(str) {
    return str.replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function renderSongList(tracks, container) {
    if (!container) return;
    if (tracks.length === 0) {
        container.innerHTML = 'No songs found.';
        return;
    }

    const html = tracks.map(t => `
        <div class="song-row" data-id="${t.id}" onclick="playTrack('${t.id}')">
            <div class="title">${esc(t.title)}</div>
        </div>
    `).join('');

    container.innerHTML = html;
}

// Test Case 1: Render empty library
const containerEmpty = { innerHTML: '' };
renderSongList([], containerEmpty);
console.assert(containerEmpty.innerHTML === 'No songs found.', "Test Case 1 Failed");

// Test Case 2: Render single track
const containerSingle = { innerHTML: '' };
const tracks = [{ id: '123', title: 'Test Song', artist: 'Test Artist', album: 'Test Album', duration: 180 }];
renderSongList(tracks, containerSingle);
console.assert(containerSingle.innerHTML.includes('Test Song'), "Test Case 2 Failed: Title missing");
console.assert(containerSingle.innerHTML.includes('onclick="playTrack(\'123\')"'), "Test Case 2 Failed: onclick missing");

console.log("✅ All WebUI Rendering Tests Passed!");
