import { Toolbar } from './ui/Toolbar';
import { TreePanel } from './ui/TreePanel';
import { CanvasView } from './ui/CanvasView';
import { Inspector } from './ui/Inspector';
import { Timeline } from './ui/Timeline';

export default function App() {
  return (
    <div className="app">
      <Toolbar />
      <TreePanel />
      <CanvasView />
      <Inspector />
      <Timeline />
    </div>
  );
}
