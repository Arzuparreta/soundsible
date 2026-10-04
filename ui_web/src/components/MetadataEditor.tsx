import { actions } from '../stores';
import type { Track } from '../types/music';
import { openTrackMetadataEditor } from './metadataEditorView';

/** Web writes retain the collection store's lifetime and refresh semantics. */
export function openMetadataEditor(track: Track): void {
  openTrackMetadataEditor(track, {
    update: values => actions.updateTrackMetadata(track.id, values),
    upload: file => actions.uploadTrackCover(track.id, file),
    remove: () => actions.clearTrackCover(track.id),
  });
}
