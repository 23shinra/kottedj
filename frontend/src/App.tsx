import { useEffect, useRef } from 'react';
import { useIsStale, useStore } from './store';
import { startLive } from './api/live';
import { api } from './api/rest';
import { Login } from './components/Login';
import { TopBar } from './components/TopBar';
import { KpiStrip } from './components/KpiStrip';
import { StationSchema } from './components/StationSchema';
import { BottomPanel } from './components/BottomPanel';
import { RecommendationsPanel } from './components/RecommendationsPanel';
import { QueuePanel } from './components/QueuePanel';
import { IndexFactorsPanel } from './components/IndexFactorsPanel';
import { EventLog } from './components/EventLog';
import { IncidentDrawer } from './components/IncidentDrawer';
import { VariantsModal } from './components/VariantsModal';
import { SettingsModal } from './components/SettingsModal';
import { CompareView, timelineToHist } from './components/CompareView';
import { HistoryBar } from './components/HistoryBar';
import { BaselineNote, ConnectionBanner, HistoryBanner, LatencyProbe, Toasts } from './components/Banners';

function Dashboard() {
  const mode = useStore((s) => s.mode);
  const stale = useIsStale();
  const history = useStore((s) => !!s.historyView);
  const online = useStore((s) => s.conn.status === 'online');
  const prefilled = useRef(false);

  useEffect(() => startLive(), []);

  // предзаполнение спарклайнов и графиков сравнения историей с сервера
  useEffect(() => {
    if (!online || prefilled.current) return;
    prefilled.current = true;
    api
      .timeline(15)
      .then((r) => useStore.getState().mergeTimeline(timelineToHist(r.points ?? [])))
      .catch(() => undefined);
  }, [online]);

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const s = useStore.getState();
      if (e.key === 'Escape' && s.selection && !s.incidentOpen && !s.settingsOpen && !s.variantsOpen) s.select(null);
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);

  return (
    <div className={`app ${stale ? 'is-stale' : ''} ${history ? 'is-history' : ''} mode-${mode}`}>
      <a href="#main" className="skip">Перейти к содержимому</a>
      <TopBar />
      <div className="banners">
        <ConnectionBanner />
        <HistoryBanner />
        <BaselineNote />
      </div>
      <KpiStrip />
      <main id="main" className="main">
        <div className="center live">
          {mode === 'compare' ? (
            <CompareView />
          ) : (
            <>
              <StationSchema />
              <BottomPanel />
            </>
          )}
        </div>
        <aside className="right live" aria-label="Рекомендации, очередь, индекс и журнал">
          <RecommendationsPanel />
          <QueuePanel />
          <IndexFactorsPanel />
          <EventLog />
        </aside>
      </main>
      <HistoryBar />
      <IncidentDrawer />
      <VariantsModal />
      <SettingsModal />
      <Toasts />
      <LatencyProbe />
    </div>
  );
}

export default function App() {
  const token = useStore((s) => s.auth.token);
  return token ? <Dashboard /> : <Login />;
}
