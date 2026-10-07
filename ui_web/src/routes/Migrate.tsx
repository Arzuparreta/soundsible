import { useNavigate } from '@solidjs/router';
import { MigrateView } from './MigrateView';

export default function Migrate() {
  const navigate = useNavigate();
  return <MigrateView onOpenPlaylists={() => navigate('/playlists')} />;
}
