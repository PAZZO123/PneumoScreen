#!/usr/bin/env python3
"""Exercise the PneumoScreen BLE gateway firmware over USB serial (no phone needed).

Records a step with the serial debug commands, dumps the held frames ('W'),
and checks them the way the app's StepAssembler does: every seq present,
END frame count / byte count / CRC-32 match. Audio is saved as a WAV.

Usage:
    python tools/gateway_test.py [--port /dev/cu.usbmodemXXXX] [--steps lung,breath] [--out out_dir]
"""
import argparse, glob, os, struct, sys, time, wave, zlib

import serial

KIND = {0x01: 'audio', 0x02: 'accel', 0x03: 'breath', 0x04: 'temp', 0x05: 'spo2', 0x7F: 'end'}
STEPS = {'lung': ('L', 2, 10), 'breath': ('A', 1, 30), 'temp': ('T', 6, 1)}


def find_port():
    ports = sorted(glob.glob('/dev/cu.usbmodem*'))
    if not ports:
        sys.exit('no /dev/cu.usbmodem* port; is the board connected?')
    return ports[0]


def read_until(ser, predicate, timeout):
    end = time.time() + timeout
    lines = []
    while time.time() < end:
        line = ser.readline().decode('utf-8', 'replace').strip()
        if not line:
            continue
        lines.append(line)
        if predicate(line):
            return line, lines
    return None, lines


def run_step(ser, name, out_dir):
    cmd, step_id, secs = STEPS[name]
    ser.reset_input_buffer()
    ser.write(b'K')            # free anything held from before
    time.sleep(0.2)
    t0 = time.time()
    ser.write(cmd.encode())
    hit, lines = read_until(ser, lambda l: l.startswith('GW: transfer') or 'ERR' in l, secs + 20)
    for l in lines:
        print('   ', l)
    if not hit or 'ERR' in hit:
        print(f'FAIL {name}: no transfer line')
        return False
    rec_s = time.time() - t0
    time.sleep(0.3)
    ser.reset_input_buffer()
    ser.write(b'W')
    hit, lines = read_until(ser, lambda l: l.startswith('DUMP: end') or l.startswith('DUMP: nothing'), 120)
    frames = [bytes.fromhex(l[2:]) for l in lines if l.startswith('F:')]
    if not hit or 'nothing' in hit:
        print(f'FAIL {name}: dump failed ({hit})')
        return False

    by_seq = {}
    end = None
    for f in frames:
        seq, kind, stp = struct.unpack_from('<HBB', f)
        if stp != step_id:
            print(f'FAIL {name}: frame {seq} has step {stp}, expected {step_id}')
            return False
        if kind == 0x7F:
            end = struct.unpack_from('<HII', f, 4)
        else:
            by_seq[seq] = (kind, f[4:])
    if end is None:
        print(f'FAIL {name}: no END frame')
        return False
    total, nbytes, crc = end
    missing = [s for s in range(total) if s not in by_seq]
    payload = b''.join(by_seq[s][1] for s in range(total) if s in by_seq)
    ok = not missing and len(payload) == nbytes and (zlib.crc32(payload) & 0xFFFFFFFF) == crc
    print(f'  {name}: recorded in {rec_s:.1f} s, frames={total} bytes={nbytes} '
          f'missing={len(missing)} crc={"ok" if ok else "BAD"}')
    if not ok:
        return False

    parts = {}
    for s in range(total):
        kind, p = by_seq[s]
        parts.setdefault(KIND.get(kind, hex(kind)), []).append(p)
    if 'audio' in parts:
        pcm = b''.join(parts['audio'])
        n = len(pcm) // 2
        samples = struct.unpack(f'<{n}h', pcm)
        rms = (sum(x * x for x in samples) / max(1, n)) ** 0.5 / 32768
        peak = max(abs(x) for x in samples) / 32768
        print(f'  audio: {n} samples = {n / 4000:.2f} s @ 4 kHz, rms={rms:.4f} peak={peak:.3f}')
        path = os.path.join(out_dir, f'{name}.wav')
        with wave.open(path, 'wb') as w:
            w.setnchannels(1); w.setsampwidth(2); w.setframerate(4000); w.writeframes(pcm)
        print(f'  saved {path}')
        if n < 4000 * secs * 0.95:
            print(f'FAIL {name}: only {n} samples, expected ~{4000 * secs}')
            return False
    if 'accel' in parts:
        acc = b''.join(parts['accel'])
        print(f'  accel: {len(acc) // 6} samples (10 Hz)')
    if 'breath' in parts:
        bpm, q = parts['breath'][-1][:2]
        print(f'  breath: {bpm} /min, quality {q}%')
    if 'temp' in parts:
        t, h = struct.unpack('<hH', parts['temp'][-1][:4])
        print(f'  temp: {t / 100:.2f} C, humidity {h / 100:.1f} %')
    ser.write(b'K')
    return True


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument('--port')
    ap.add_argument('--steps', default='lung,breath')
    ap.add_argument('--out', default='build/gateway_test')
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    ser = serial.Serial(a.port or find_port(), 115200, timeout=1)
    time.sleep(1.0)
    ser.reset_input_buffer()
    ser.write(b'P')
    hit, _ = read_until(ser, lambda l: l.startswith('STATUS:'), 5)
    print(hit or 'no STATUS reply (is the gateway firmware running?)')
    if not hit:
        sys.exit(1)
    results = {s: run_step(ser, s, a.out) for s in a.steps.split(',')}
    ser.close()
    print('\n' + '  '.join(f'{k}: {"PASS" if v else "FAIL"}' for k, v in results.items()))
    sys.exit(0 if all(results.values()) else 1)


if __name__ == '__main__':
    main()
