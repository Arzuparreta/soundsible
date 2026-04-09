/**
 * Shared metadata editor controller for mobile and desktop.
 */

export function createMetadataEditor(options) {
    const {
        store,
        resolver,
        getTrackById,
        getElements,
        showToast,
        triggerHaptics = () => {},
        onOpen = () => {},
        onClose = () => {}
    } = options;

    const state = {
        editingTrack: null,
        bound: false
    };

    const show = (trackId) => {
        const track = getTrackById(trackId);
        if (!track) return;
        const el = getElements();
        onOpen();
        state.editingTrack = track;
        if (el.editTitle) el.editTitle.value = track.title || '';
        if (el.editArtist) el.editArtist.value = track.artist || '';
        if (el.editAlbum) el.editAlbum.value = track.album || '';
        if (el.editCoverPreview) el.editCoverPreview.src = resolver.getCoverUrl(track);
        if (el.editRawYoutubeNote) {
            el.editRawYoutubeNote.textContent = '';
            el.editRawYoutubeNote.classList.add('hidden');
        }
        if (el.editStatus) el.editStatus.textContent = '';
        if (el.metadataEditor) el.metadataEditor.classList.remove('hidden');
        setTimeout(() => {
            if (el.metadataEditorContent) {
                el.metadataEditorContent.classList.replace('scale-95', 'scale-100');
                el.metadataEditorContent.classList.replace('opacity-0', 'opacity-100');
            }
        }, 10);

        if (!state.bound) {
            if (el.editSaveBtn) el.editSaveBtn.onclick = () => save();
            if (el.editUploadBtn && el.editFileInput) {
                el.editUploadBtn.onclick = () => {
                    triggerHaptics(10);
                    el.editFileInput.click();
                };
                el.editFileInput.onchange = (event) => handleCoverUpload(event);
            }
            state.bound = true;
        }
    };

    const hide = () => {
        const el = getElements();
        if (el.metadataEditorContent) {
            el.metadataEditorContent.classList.replace('scale-100', 'scale-95');
            el.metadataEditorContent.classList.replace('opacity-100', 'opacity-0');
        }
        setTimeout(() => {
            if (el.metadataEditor) el.metadataEditor.classList.add('hidden');
        }, 300);
        onClose();
    };

    const save = async () => {
        if (!state.editingTrack) return;
        const el = getElements();
        triggerHaptics(30);
        if (el.editStatus) el.editStatus.textContent = 'Saving Changes...';
        const metadata = {
            title: el.editTitle?.value ?? '',
            artist: el.editArtist?.value ?? '',
            album: el.editAlbum?.value ?? ''
        };
        const success = await store.updateMetadata(state.editingTrack.id, metadata);
        if (success) {
            showToast('Metadata Updated');
            hide();
        } else if (el.editStatus) {
            el.editStatus.textContent = 'Save Failed';
        }
    };

    const handleCoverUpload = async (event) => {
        const file = event?.target?.files?.[0];
        if (!file || !state.editingTrack) return;
        const el = getElements();
        triggerHaptics(20);
        if (el.editStatus) el.editStatus.textContent = 'Uploading Cover Art...';
        const success = await store.uploadCover(state.editingTrack.id, file);
        if (success) {
            showToast('Cover Art Updated');
            if (el.editCoverPreview) {
                const blobUrl = URL.createObjectURL(file);
                el.editCoverPreview.src = blobUrl;
                el.editCoverPreview.onload = () => URL.revokeObjectURL(blobUrl);
            }
            if (el.editStatus) el.editStatus.textContent = 'Cover applied';
        } else if (el.editStatus) {
            el.editStatus.textContent = 'Upload Failed';
        }
        if (event?.target) event.target.value = '';
    };

    return { show, hide, save, handleCoverUpload };
}
