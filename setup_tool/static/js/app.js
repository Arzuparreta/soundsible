const socket = io();

// ## Section: UI elements
const connectionDot = document.getElementById('connection-dot');
const connectionStatus = document.getElementById('connection-status');
const uploadBtn = document.getElementById('upload-btn');
const pathInput = document.getElementById('path-input');
const progressSection = document.getElementById('progress-section');
const mainProgressBar = document.getElementById('main-progress-bar');
const totalPercent = document.getElementById('total-percent');
const activityLog = document.getElementById('activity-log');
const dropZone = document.getElementById('drop-zone');

// ## Section: Socket events
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
    // Note: Basic tasks handling
    // Note: If we have total/completed for a single task, we update log or specific bar
    // Note: For MVP we just use the main task updates to drive the main bar roughly

    if (data.total && data.completed) {
        // ## Section: Calculate percentage
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

// ## Section: User interactions
if (uploadBtn) {
    uploadBtn.addEventListener('click', () => {
        startUpload();
    });
}

// ## Section: Drag and drop logic
if (dropZone) {
    // Note: Prevent default browser behavior for the entire window
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => e.preventDefault());

    // Note: Highlight drop zone
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

        // Note: Check if files were dropped
        if (e.dataTransfer.files.length > 0) {
            // Note: Browser security hides absolute filesystem paths during drag and drop.
            // Note: Use the path input field directly to provide a valid local path.

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

// ## Section: Helper functions
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

// ## Section: Safe wipe logic

const wipeBtnTrigger = document.getElementById('wipe-btn-trigger');
const wipeModal = document.getElementById('wipe-modal');
const wipeConfirmInput = document.getElementById('wipe-confirm-input');
const wipeConfirmBtn = document.getElementById('wipe-confirm-btn');
const wipeCancelBtn = document.getElementById('wipe-cancel-btn');

// Note: Read the target bucket name from the UI for client-side confirmation.
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
            // ## Section: Show progress
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
