import * as echarts from 'echarts/core';
import { CustomChart, LineChart, ScatterChart } from 'echarts/charts';
import {
  GridComponent,
  TooltipComponent,
  MarkLineComponent,
  MarkAreaComponent,
  LegendComponent,
  AxisPointerComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import { SEMANTIC } from './theme';

echarts.use([
  CustomChart,
  LineChart,
  ScatterChart,
  GridComponent,
  TooltipComponent,
  MarkLineComponent,
  MarkAreaComponent,
  LegendComponent,
  AxisPointerComponent,
  CanvasRenderer,
]);

export { echarts };

export const FONT = '"Inter Variable", Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

export const tooltipBase = {
  backgroundColor: 'rgba(14,22,37,0.97)',
  borderColor: '#2b3a57',
  borderWidth: 1,
  padding: [8, 10],
  textStyle: { color: SEMANTIC.text, fontSize: 12, fontFamily: FONT },
  extraCssText: 'box-shadow:0 8px 24px rgba(0,0,0,.45);border-radius:8px;',
};

export const axisCommon = {
  axisLine: { lineStyle: { color: '#2a3956' } },
  axisTick: { lineStyle: { color: '#2a3956' } },
  axisLabel: { color: SEMANTIC.muted, fontSize: 11, fontFamily: FONT },
  splitLine: { lineStyle: { color: SEMANTIC.grid, type: 'dashed' as const } },
};
