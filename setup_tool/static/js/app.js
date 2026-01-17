const socket = io();

// UI Elements
const connectionDot = document.getElementById('connection-dot');
const connectionStatus = document.getElementById('connection-status');
const uploadBtn = document.getElementById('upload-btn');
const pathInput = document.getElementById('path-input');
const progressSection = document.getElementById('progress-section');
const mainProgressBar = document.getElementById('main-progress-bar');
const totalPercent = document.getElementById('total-percent');
const activityLog = document.getElementById('activity-log');
const dropZone = document.getElementById('drop-zone');

// Socket Events
socket.on('connect', () => {
    updateStatus(true);
});

socket.on('disconnect', () => {
    updateStatus(false);
});

socket.on('upload_error', (data) => {
    logMessage(`Error: ${data.msg}`, 'text-red-500');
    alert(`Upload Error: ${data.msg}`);
});

socket.on('upload_started', (data) => {
    progressSection.classList.remove('hidden');
    dropZone.classList.add('uploading-active');
    logMessage(`Starting upload from: ${data.path}`, 'text-green-400');
});

socket.on('progress_update', (data) => {
    // Basic tasks handling
    // If we have total/completed for a single task, we update log or specific bar
    // For MVP we just use the main task updates to drive the main bar roughly

    if (data.total && data.completed) {
        // Calculate percentage
        const percent = Math.round((data.completed / data.total) * 100);
        mainProgressBar.style.width = `${percent}%`;
        totalPercent.textContent = `${percent}%`;
    }

    if (data.description) {
        logMessage(data.description);
    }
});

socket.on('upload_complete', (data) => {
    dropZone.classList.remove('uploading-active');
    mainProgressBar.style.width = '100%';
    totalPercent.textContent = '100%';
    logMessage(`[COMPLETE] Upload Complete! ${data.tracks} tracks processed.`, 'text-green-400 font-bold');
});

// User Interactions
if (uploadBtn) {
    uploadBtn.addEventListener('click', () => {
        startUpload();
    });
}

// Drag and Drop Logic
if (dropZone) {
    // Prevent default browser behavior for the entire window
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => e.preventDefault());

    // Highlight drop zone
    dropZone.addEventListener('dragenter', () => {
        dropZone.classList.add('border-blue-500', 'bg-gray-800');
    });

    dropZone.addEventListener('dragleave', () => {
        dropZone.classList.remove('border-blue-500', 'bg-gray-800');
    });

    dropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
    });

    dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropZone.classList.remove('border-blue-500', 'bg-gray-800');

        // Check if files were dropped
        if (e.dataTransfer.files.length > 0) {
            // NOTE: Due to browser security sandbox, we can't easily get the absolute path
            // unless the user configured the browser to allow it or we use webkitRelativePath for folders.
            // However, since this is a local tool (localhost), we can't actually read the full path from 
            // the DOM File object for Security reasons in most modern browsers.
            //
            // Workaround for Local Tool: 
            // We can't "upload" the bytes via socketIO efficiently for huge libraries in this MVP.
            // We asked the user to drag a FOLDER or enter a PATH.
            // 
            // If the user drags a file/folder, we can try to guess or use the 'path' input.
            // Use the file.path property (Electron/some configs) OR just prompt the user?
            //
            // WAIT - This is running in a standard Chrome/Firefox. 'File' object does NOT have full path.
            // The user must manually Paste the path or we assume the backend can see it? No.
            // 
            // Actually, if we want dragging to work for a "Setup Tool" running locally,
            // we typically need an Electron wrapper or we accept that we can only upload "Files" (bytes),
            // not "scan a folder path" unless the user types the path.
            // 
            // But wait, my previous UploadEngine expects a valid OS PATH.
            // `socket.emit('start_upload', { path: path });`
            //
            // If I drop a file in browser, I get a File object (bytes). I can stream bytes.
            // But scan_directory() needs a Path.
            // 
            // CORRECTION: The "Drag & Drop" feature implies uploading the FILES via HTTP/WebSocket, not just sending the path string.
            // BUT, my backend code `web.py` calls `uploader.run(path...)`. It does NOT take file streams.
            // 
            // So, for this "Drag & Drop" to work as implied (sending the path), it's impossible in a normal browser 
            // because `File.path` is hidden.
            // 
            // HOWEVER, since the user is likely on the same machine (Localhost), maybe we can assume 
            // they can copy-paste the path?
            // OR we change the UI to "Enter Path" primarily.
            //
            // But the user just said "my browser opens the audio file".
            // So they WANT to drag and drop.
            // 
            // Resolution: I will prevent default so it doesn't play.
            // Then I will display a message: 
            // "Due to browser security, please COPY & PASTE the folder path instead."
            // 
            // OR, better: `input type="file" webkitdirectory"` allows selecting a folder.
            // But that still doesn't give the absolute path easily to the backend (it gives relative paths).
            //
            // Wait, if I use `input type="file"`, I can upload the *content*.
            // My `UploadEngine` expects a path on disk.
            // 
            // To fix this quickly without rewriting the engine to accept streams:
            // I'll make the drop handler say: "Path detection blocked by browser. Please paste the path."
            //
            // UNLESS: I'm just pasting the path string?
            // Some Linux file managers dragging into text input pastes the path.
            // 
            // Let's try to capture the path if possible (rare) or instruct the user.

            // Actually, if they drag to the INPUT field, it usually pastes the path on Linux!
            // I'll tell them to drag to the INPUT field.

            alert("Browser security prevents reading the full path from a drop.\nPlease drag the folder into the 'Path' text box directly, or copy-paste the path.");
        }
    });
}

function startUpload() {
    const path = pathInput.value.trim();
    if (!path) {
        alert('Please enter a directory path');
        return;
    }
    socket.emit('start_upload', { path: path });
}

// Helper Functions
function updateStatus(connected) {
    if (connected) {
        connectionDot.classList.remove('bg-red-500');
        connectionDot.classList.add('bg-green-500');
        connectionStatus.textContent = 'Connected';
    } else {
        connectionDot.classList.remove('bg-green-500');
        connectionDot.classList.add('bg-red-500');
        connectionStatus.textContent = 'Disconnected';
    }
}

function logMessage(msg, classes = '') {
    const p = document.createElement('p');
    p.textContent = `> ${msg}`;
    if (classes) {
        p.className = classes;
    }
    activityLog.appendChild(p);
    activityLog.scrollTop = activityLog.scrollHeight;
}

// --- Safe Wipe Logic ---

const wipeBtnTrigger = document.getElementById('wipe-btn-trigger');
const wipeModal = document.getElementById('wipe-modal');
const wipeConfirmInput = document.getElementById('wipe-confirm-input');
const wipeConfirmBtn = document.getElementById('wipe-confirm-btn');
const wipeCancelBtn = document.getElementById('wipe-cancel-btn');

// We need to know the bucket name to validate client-side or we rely on server check.
// Ideally, we grab it from the DOM or inject it. 
// In index.html we used {{ config.bucket }} to show it.
// Let's grab it from the text content of the span we added.
const bucketNameSpan = document.querySelector('.select-all');
const targetBucketName = bucketNameSpan ? bucketNameSpan.textContent.trim() : '';

if (wipeBtnTrigger) {
    wipeBtnTrigger.addEventListener('click', () => {
        wipeModal.classList.remove('hidden');
        wipeConfirmInput.value = '';
        wipeConfirmBtn.disabled = true;
        wipeConfirmInput.focus();
    });
}

if (wipeCancelBtn) {
    wipeCancelBtn.addEventListener('click', () => {
        wipeModal.classList.add('hidden');
    });
}

if (wipeConfirmInput) {
    wipeConfirmInput.addEventListener('input', (e) => {
        if (e.target.value === targetBucketName) {
            wipeConfirmBtn.disabled = false;
            wipeConfirmBtn.classList.remove('opacity-50', 'cursor-not-allowed');
        } else {
            wipeConfirmBtn.disabled = true;
            wipeConfirmBtn.classList.add('opacity-50', 'cursor-not-allowed');
        }
    });
}

if (wipeConfirmBtn) {
    wipeConfirmBtn.addEventListener('click', () => {
        if (wipeConfirmInput.value === targetBucketName) {
            socket.emit('wipe_bucket', {
                confirmation: wipeConfirmInput.value
            });
            wipeModal.classList.add('hidden');
            // Show progress
            progressSection.classList.remove('hidden');
            logMessage('Initiating Safe Wipe...', 'text-red-400');
        }
    });
}

socket.on('wipe_error', (data) => {
    alert(`Wipe Error: ${data.msg}`);
    logMessage(`Wipe Failed: ${data.msg}`, 'text-red-500');
});

socket.on('wipe_started', (data) => {
    logMessage(`[WARNING] Wiping bucket '${data.bucket}'...`, 'text-red-500 font-bold');
    dropZone.classList.add('opacity-50', 'pointer-events-none');
});

socket.on('wipe_progress', (data) => {
    if (data.msg) logMessage(data.msg);
    if (data.percent) {
        mainProgressBar.style.width = `${data.percent}%`;
        totalPercent.textContent = `${data.percent}%`;
    }
});

socket.on('wipe_complete', (data) => {
    mainProgressBar.style.width = '100%';
    totalPercent.textContent = '100%';
    logMessage(`[COMPLETE] Bucket Wiped. ${data.count} files deleted.`, 'text-red-500 font-bold');
    dropZone.classList.remove('opacity-50', 'pointer-events-none');
    alert(`Bucket Wipe Complete.\nDeleted ${data.count} files.`);
});
