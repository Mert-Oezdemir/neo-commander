import { FolderList } from '../components/FolderList';
import { KillSwitch } from '../components/KillSwitch';
import { ModeSelector } from '../components/ModeSelector';
import { PageHeader } from '../components/PageHeader';
import { useApp } from '../state/store';

export function SecurityPage() {
  const { snapshot } = useApp();
  if (!snapshot) return null;
  return (
    <>
      <PageHeader title="Güvenlik" lead="Yapay zekanın nelere dokunabileceğini burada sınırlarsınız." />
      <KillSwitch paused={snapshot.paused} />
      <ModeSelector mode={snapshot.mode} />
      <FolderList dirs={snapshot.allowedDirectories} />
    </>
  );
}
