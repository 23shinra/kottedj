import { useState } from 'react';
import { EventLogView } from './EventLog';
import { IndexFactorsView } from './IndexFactorsPanel';
import { QueueView, useQueueRows } from './QueuePanel';
import { Tabs } from './common';

type SideTab = 'queue' | 'index' | 'log';

export function SidePanel() {
  const [tab, setTab] = useState<SideTab>('queue');
  const queue = useQueueRows().length;
  return (
    <section className="panel side-panel" aria-label="Очередь на подходе, индекс и журнал">
      <header className="panel-h">
        <Tabs
          idPrefix="side"
          label="Боковая панель"
          value={tab}
          onChange={setTab}
          items={[
            { id: 'queue', label: 'Очередь на подходе', count: queue },
            { id: 'index', label: 'Индекс' },
            { id: 'log', label: 'Журнал' },
          ]}
        />
      </header>
      <div className="side-b" role="tabpanel" id="side-panel" aria-labelledby={`side-tab-${tab}`}>
        {tab === 'queue' && <QueueView />}
        {tab === 'index' && <IndexFactorsView />}
        {tab === 'log' && <EventLogView />}
      </div>
    </section>
  );
}
