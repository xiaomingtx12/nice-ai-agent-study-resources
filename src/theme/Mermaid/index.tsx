import {useId, useMemo, type ReactNode} from 'react';
import DiagramViewer, {type DiagramResult} from '../../components/DiagramViewer';

export type StaticMermaidProps = Omit<DiagramResult, 'width' | 'height'> & {
  diagramId: string; width: number | string; height: number | string;
};

// Markdown 编译阶段已经生成 SVG；这里仅隔离实例 ID，不加载 Mermaid 或重新计算布局。
export default function Mermaid({svg, width, height, diagramId}: StaticMermaidProps): ReactNode {
  const instanceId = 'mermaid-' + useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const result = useMemo(() => {
    // Markdown 的 HAST 属性会把尺寸序列化成字符串，统一还原后交给查看器。
    const svgWidth = Number(width);
    const svgHeight = Number(height);
    if (!svg || !diagramId || !Number.isFinite(svgWidth) || !Number.isFinite(svgHeight) || svgWidth <= 0 || svgHeight <= 0) {
      throw new Error('图表缺少预渲染数据，请检查 staticMermaid Markdown 插件。');
    }
    return {svg: svg.split(diagramId).join(instanceId), width: svgWidth, height: svgHeight};
  }, [svg, width, height, diagramId, instanceId]);
  return <DiagramViewer result={result} />;
}
