import { MigrateView } from '../routes/MigrateView';
import { chooseNativeImport } from './import';

/** Shared migration jobs, with grants and bytes kept in the native transport. */
export default function NativeMigrate(props: { generation: number; current: () => boolean; available: () => boolean; origin: string; onOpenPlaylists: () => void }) {
  const generation = props.generation;
  return <MigrateView compact current={props.current} available={props.available}
    stationAddress={() => `${props.origin.replace(/\/$/, '')}/migrate`}
    chooseUpload={signal => chooseNativeImport(generation, signal)}
    onOpenPlaylists={props.onOpenPlaylists} />;
}
