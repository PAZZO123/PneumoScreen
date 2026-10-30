# record_imu.py
# Guided recording of raw accelerometer data from firmware/breath_rate (raw mode 'r'),
# used to tune the breathing-rate detector. Saves CSVs to data/device/imu/.
#   python tools/record_imu.py
import json, os, time, datetime
import serial
from serial.tools import list_ports

PHASES = [
    ('still',        30, 'Put the board on the floor or table and do NOT touch it.'),
    ('chest_normal', 60, 'Lie on your back, board flat on your chest. Breathe normally and COUNT your breaths.'),
    ('chest_fast',   40, 'Same position. Breathe FAST (about one breath per second) and COUNT your breaths.'),
]
OUT = 'data/device/imu'


def find_port():
    for p in list_ports.comports():
        if p.vid == 0x2341: return p.device
    raise SystemExit('No Arduino found - plug in the board and close the Arduino Serial Monitor.')


def main():
    os.makedirs(OUT, exist_ok=True)
    stamp = datetime.datetime.now().strftime('%Y%m%d_%H%M%S')
    ser = serial.Serial(find_port(), 115200, timeout=1)
    time.sleep(1)
    ser.write(b'r')                                  # switch the sketch to raw output
    counts = {}
    try:
        for name, secs, howto in PHASES:
            print(f'\n=== {name.upper()} ({secs} s) ===\n{howto}')
            input('Press Enter when ready...')
            for i in (3, 2, 1): print(f'  starting in {i}...'); time.sleep(1)
            print('  RECORDING - start counting now')
            ser.reset_input_buffer()
            rows, t0 = [], time.time()
            while time.time() - t0 < secs:
                p = ser.readline().decode(errors='replace').strip().split(',')
                if len(p) == 4:
                    try: rows.append([int(p[0])] + [float(v) for v in p[1:]])
                    except ValueError: pass
                left = secs - int(time.time() - t0)
                print(f'\r  {left:3d} s left   ', end='', flush=True)
            print('\r  done.            ')
            path = f'{OUT}/{name}_{stamp}.csv'
            with open(path, 'w') as f:
                f.write('ms,ax,ay,az\n'); f.writelines(f'{r[0]},{r[1]},{r[2]},{r[3]}\n' for r in rows)
            if name != 'still':
                n = input('  How many breaths did you count? (Enter to skip): ').strip()
                counts[name] = int(n) if n.isdigit() else None
            rate = len(rows) / secs
            print(f'  saved {len(rows)} samples ({rate:.0f} Hz) -> {path}')
    finally:
        ser.write(b'r'); ser.close()                 # back to normal output
    json.dump({'stamp': stamp, 'counts': counts, 'durations': {n: s for n, s, _ in PHASES}},
              open(f'{OUT}/session_{stamp}.json', 'w'), indent=1)
    print('\nAll done - tell Claude the recording is finished.')


if __name__ == '__main__':
    main()
