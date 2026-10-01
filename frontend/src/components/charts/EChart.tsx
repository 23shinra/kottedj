import { memo } from 'react';
import ReactEChartsCore from 'echarts-for-react/esm/core';
import { echarts } from '../../utils/echarts';

interface Props {
  option: unknown;
  onEvents?: Record<string, (p: unknown) => void>;
  className?: string;
  ariaLabel: string;
  replaceMerge?: string[];
}

/** Обёртка: notMerge=false + lazyUpdate — обновление 2 Гц без пересоздания графика. */
export const EChart = memo(function EChart({ option, onEvents, className, ariaLabel, replaceMerge }: Props) {
  return (
    <div className={`echart ${className ?? ''}`} role="img" aria-label={ariaLabel}>
      <ReactEChartsCore
        echarts={echarts}
        option={option}
        notMerge={false}
        lazyUpdate
        replaceMerge={replaceMerge}
        onEvents={onEvents}
        style={{ width: '100%', height: '100%' }}
        opts={{ renderer: 'canvas' }}
      />
    </div>
  );
});
