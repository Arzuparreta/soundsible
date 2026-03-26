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
        if (el.autoFetchResults) {
            el.autoFetchResults.innerHTML = '';
            el.autoFetchResults.classList.add('hidden');
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
            if (el.editAutoFetchBtn) el.editAutoFetchBtn.onclick = () => autoFetch();
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

    const applyFetched = (title, artist, album, cover) => {
        const el = getElements();
        triggerHaptics(10);
        if (el.editTitle) el.editTitle.value = title || '';
        if (el.editArtist) el.editArtist.value = artist || '';
        if (el.editAlbum) el.editAlbum.value = album || '';
        if (el.editCoverPreview) el.editCoverPreview.src = cover || store.placeholderCoverUrl;
        if (el.autoFetchResults) el.autoFetchResults.classList.add('hidden');
        if (el.editStatus) el.editStatus.textContent = 'Metadata applied locally';
    };

    const autoFetch = async () => {
        if (!state.editingTrack) return;
        const el = getElements();
        triggerHaptics(20);
        if (el.editStatus) el.editStatus.textContent = 'Searching technical data...';
        if (el.autoFetchResults) {
            el.autoFetchResults.innerHTML = '';
            el.autoFetchResults.classList.add('hidden');
        }
        const query = `${el.editTitle?.value ?? ''} ${el.editArtist?.value ?? ''}`;
        const results = await store.searchMetadata(query);
        if (!results || results.length === 0) {
            if (el.editStatus) el.editStatus.textContent = 'No matches found';
            return;
        }
        if (el.editStatus) el.editStatus.textContent = 'Matches found';
        if (!el.autoFetchResults) return;
        const escAttr = (v) => (v || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;');
        const escText = (v) => (v || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const placeholder = store.placeholderCoverUrl.replace(/'/g, "\\'");
        el.autoFetchResults.classList.remove('hidden');
        el.autoFetchResults.innerHTML = results.slice(0, 5).map((r) => `
            <div class="flex items-center p-3 hover:bg-[var(--surface-overlay)] rounded-[var(--radius-omni-sm)] cursor-pointer transition-colors border border-transparent active:border-[var(--accent)]/30 active:bg-[var(--accent)]/5"
                data-meta-title="${escAttr(r.title)}"
                data-meta-artist="${escAttr(r.artist)}"
                data-meta-album="${escAttr(r.album)}"
                data-meta-cover="${escAttr(r.cover)}">
                <img src="${escAttr(r.cover)}" class="w-10 h-10 rounded-[var(--radius-omni-xs)] object-cover shadow-md" onerror="this.src='${placeholder}'">
                <div class="ml-3 truncate">
                    <div class="text-xs font-bold truncate text-[var(--text-main)]">${escText(r.title)}</div>
                    <div class="text-[9px] font-bold text-[var(--text-dim)] truncate uppercase tracking-widest font-mono">${escText(r.artist)}</div>
                </div>
            </div>
        `).join('');

        el.autoFetchResults.querySelectorAll('[data-meta-title]').forEach((node) => {
            node.addEventListener('click', () => {
                applyFetched(
                    node.getAttribute('data-meta-title') || '',
                    node.getAttribute('data-meta-artist') || '',
                    node.getAttribute('data-meta-album') || '',
                    node.getAttribute('data-meta-cover') || ''
                );
            });
        });
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

    return { show, hide, save, autoFetch, applyFetched, handleCoverUpload };
}
