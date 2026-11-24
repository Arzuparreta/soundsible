// Resolve both modes and compact lyrics on first opening the player. An open
// NORMAL workspace must not need a now-obsolete DJ chunk after the station
// publishes a new UI; components still mount separately.
export { NowPlaying } from './NowPlaying';
export { AutoMode } from './AutoMode';
export { LyricsPanel } from './LyricsPanel';
