import { Flag, State } from '../ble';
import { useDevice } from '../device';

// Mirrors ui_refresh() in firmware/pneumoscreen/pneumoscreen.ino, which draws
// ui_step(title, value, prompt) on the 128×64 SSD1306: what the device shows now.
const STATE_TXT = ['Ready', 'Recording', 'Sending', 'Sent', 'Error'];
const STEP_TXT = ['', 'Breath', 'Lung R-up', 'Lung L-up', 'Lung R-low', 'Lung L-low', 'Temp', 'SpO2'];

export function Oled() {
  const { status, connected, gw } = useDevice();
  const hasScreen = !!status && (status.flags & Flag.OLED_OK) !== 0;
  let value = '', prompt = '';
  if (status && hasScreen) {
    const busy = status.state === State.RECORDING || status.state === State.TRANSFERRING;
    value = busy ? `${STEP_TXT[status.step] ?? ''} ${status.progress}%` : STATE_TXT[status.state] ?? 'Error';
    prompt = connected ? 'Phone connected' : 'Open the app';
  }
  const big = value.length > 10 ? 11 : 16;   // the firmware's size-2 font overflows; shrink long values to fit
  return (
    <figure>
      <figcaption className="mb-1.5 text-sm font-semibold uppercase tracking-wide text-slate-600 dark:text-slate-600">
        Device screen {gw.simulated ? '(simulated)' : 'preview'}
      </figcaption>
      <div className="mx-auto w-full max-w-[256px] rounded-lg border-4 border-slate-800 bg-slate-800 p-1 shadow-inner">
        <svg viewBox="0 0 128 64" className="block w-full bg-black [image-rendering:pixelated]" role="img" aria-label={hasScreen ? `Device screen: PneumoScreen, ${value}, ${prompt}` : 'Device screen off'}>
          {hasScreen ? (
            <g fill="#e6f4ff" fontFamily="ui-monospace, Menlo, monospace">
              <text x="0" y="7" fontSize="8">PneumoScreen</text>
              <line x1="0" y1="10.5" x2="127" y2="10.5" stroke="#e6f4ff" strokeWidth="1" />
              <text x="64" y={22 + big * 0.8} fontSize={big} textAnchor="middle" fontWeight="bold">{value}</text>
              <text x="0" y="61" fontSize="8">{prompt}</text>
            </g>
          ) : (
            <text x="64" y="36" fontSize="7" fill="#475569" textAnchor="middle" fontFamily="ui-monospace, monospace">{connected ? 'no screen on device' : 'not connected'}</text>
          )}
        </svg>
      </div>
    </figure>
  );
}
