// Resolve both modes on first opening the player. An open NORMAL workspace
// must not need a now-obsolete DJ chunk after the station publishes a new UI.
// Components still mount separately; loading code does not enter DJ mode.
export { NowPlaying } from './NowPlaying';
export { AutoMode } from './AutoMode';
