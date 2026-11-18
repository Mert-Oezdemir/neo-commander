import { AgentGuides } from '../components/AgentGuides';
import { ConnectorCard } from '../components/ConnectorCard';
import { PageHeader } from '../components/PageHeader';
import { StatusHero } from '../components/StatusHero';
import { useApp } from '../state/store';

export function ConnectPage() {
  const { snapshot } = useApp();
  if (!snapshot) return null;
  return (
    <>
      <PageHeader title="Bağlan" lead="Yapay zekanın bu bilgisayarı kullanabilmesi için linki ve PIN’i ona verin." />
      <StatusHero snapshot={snapshot} />
      <ConnectorCard snapshot={snapshot} />
      <AgentGuides url={snapshot.connectorUrl} />
    </>
  );
}
