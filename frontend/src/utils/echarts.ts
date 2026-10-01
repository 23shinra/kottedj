import * as echarts from 'echarts/core';
import { CustomChart, LineChart, ScatterChart } from 'echarts/charts';
import {
  GridComponent,
  TooltipComponent,
  MarkLineComponent,
  MarkAreaComponent,
  LegendComponent,
  AxisPointerComponent,
  TitleComponent,
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
  TitleComponent,
  CanvasRenderer,
]);

export { echarts };

export const FONT = '"Inter Variable", Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

export const tooltipBase = {
  backgroundColor: SEMANTIC.surface2,
  borderColor: SEMANTIC.axis,
  borderWidth: 1,
  padding: [6, 8],
  textStyle: { color: SEMANTIC.text, fontSize: 12, fontFamily: FONT },
  extraCssText: 'box-shadow:0 6px 18px rgba(0,0,0,.45);border-radius:4px;',
};

export const axisCommon = {
  axisLine: { lineStyle: { color: SEMANTIC.axis } },
  axisTick: { lineStyle: { color: SEMANTIC.axis } },
  axisLabel: { color: SEMANTIC.muted, fontSize: 11, fontFamily: FONT },
  splitLine: { lineStyle: { color: SEMANTIC.grid } },
};
