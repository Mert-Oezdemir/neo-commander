import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseBoottime, parseDf, parseIfconfig, parsePmsetBatt, parsePs, parseSwVers, parseVmStat, topByCpu, topByMemory } from './mac-sysinfo.js';
import { expandHome, planOpen, type FsProbe } from './mac-open.js';
import { ArgError } from './validate.js';

describe('system_info parsers', () => {
  it('sw_vers', () => {
    assert.deepEqual(parseSwVers('ProductName:\t\tmacOS\nProductVersion:\t\t14.5\nBuildVersion:\t\t23F79\n'), { name: 'macOS', version: '14.5', build: '23F79' });
  });
  it('vm_stat -> available MB using the reported page size', () => {
    const out = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               10000.
Pages active:                            200000.
Pages inactive:                           50000.
Pages speculative:                         5000.
Pages purgeable:                           1000.
`;
    // (10000+50000+5000+1000) * 16384 / 1MiB = 1031.25 -> 1031
    assert.deepEqual(parseVmStat(out), { freeMB: 1031, pageSize: 16384 });
  });
  it('df -k: folds the Data volume into "/" and hides system volumes', () => {
    const out = `Filesystem       1024-blocks      Used Available Capacity iused      ifree %iused  Mounted on
/dev/disk3s1s1     971350180  15000000 700000000     3%  500000 4290000000    0%   /
devfs                    200       200         0   100%     690          0  100%   /dev
/dev/disk3s6       971350180   6000000 700000000     1%       6 4290000000    0%   /System/Volumes/VM
/dev/disk3s2       971350180   9000000 700000000     2%    2000 4290000000    0%   /System/Volumes/Preboot
/dev/disk3s5       971350180 240000000 700000000    26%  900000 4290000000    0%   /System/Volumes/Data
/dev/disk4s1         2000000    500000   1500000    25%      10   1500000    0%   /Volumes/USB Stick
map auto_home              0         0         0   100%       0          0  100%   /System/Volumes/Data/home
`;
    const d = parseDf(out);
    assert.deepEqual(d.map((x) => x.drive), ['/', '/Volumes/USB Stick']);
    assert.equal(d[0]!.totalGB, Math.round((971350180 / 1048576) * 10) / 10);
    assert.equal(d[0]!.freeGB, Math.round((700000000 / 1048576) * 10) / 10);
    assert.equal(d[1]!.label, 'USB Stick');
  });
  it('pmset -g batt', () => {
    const bat = `Now drawing from 'Battery Power'
 -InternalBattery-0 (id=4653155)\t87%; discharging; 5:21 remaining present: true
`;
    assert.deepEqual(parsePmsetBatt(bat), { percent: 87, charging: false, status: 'discharging' });
    assert.equal(parsePmsetBatt("Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t100%; charged; 0:00 remaining present: true\n")?.charging, true);
    assert.equal(parsePmsetBatt("Now drawing from 'AC Power'\n"), null);
  });
  it('ps and top lists', () => {
    const out = `  PID  %CPU    RSS COMM
  412  35.2 812345 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome
    1   0.0   4096 /sbin/launchd
  999  80.5 100000 /usr/bin/foo
`;
    const p = parsePs(out);
    assert.equal(p.length, 3);
    assert.equal(p[0]!.name, 'Google Chrome');
    assert.deepEqual(topByCpu(p, 2).map((x) => x.pid), [999, 412]);
    assert.deepEqual(topByMemory(p, 1)[0], { name: 'Google Chrome', pid: 412, memoryMB: 793 });
  });
  it('ifconfig and boottime', () => {
    const out = `lo0: flags=8049<UP,LOOPBACK,RUNNING,MULTICAST> mtu 16384
\tinet 127.0.0.1 netmask 0xff000000
en0: flags=8863<UP,BROADCAST,SMART,RUNNING,SIMPLEX,MULTICAST> mtu 1500
\tinet6 fe80::1%en0 prefixlen 64
\tinet 192.168.1.23 netmask 0xffffff00 broadcast 192.168.1.255
en5: flags=8863<UP> mtu 1500
\tinet 169.254.3.4 netmask 0xffff0000
`;
    assert.deepEqual(parseIfconfig(out), [{ adapter: 'en0', ipv4: '192.168.1.23' }]);
    assert.equal(parseBoottime('{ sec = 1700000000, usec = 123 } Tue Nov 14 22:13:20 2023', 1700000100), 100);
    assert.equal(parseBoottime('nope'), null);
  });
});

describe('desktop_open planning', () => {
  const probe: FsProbe = {
    home: '/Users/me',
    stat(p) {
      const t: Record<string, { isDirectory: boolean; isFile: boolean; executable: boolean }> = {
        '/Applications/Safari.app': { isDirectory: true, isFile: false, executable: true },
        '/Users/me/Documents': { isDirectory: true, isFile: false, executable: true },
        '/Users/me/notes.txt': { isDirectory: false, isFile: true, executable: false },
        '/Users/me/run.sh': { isDirectory: false, isFile: true, executable: true },
        '/usr/local/bin/tool': { isDirectory: false, isFile: true, executable: true },
        '/Users/me/report.pdf': { isDirectory: false, isFile: true, executable: true },
      };
      return t[p];
    },
  };
  it('URLs go to `open`, args are rejected for them', () => {
    assert.deepEqual(planOpen('https://example.com/a?b=1', undefined, probe), { kind: 'url', file: '/usr/bin/open', args: ['https://example.com/a?b=1'], spawn: false });
    assert.equal(planOpen('mailto:a@b.c', undefined, probe).kind, 'url');
    assert.throws(() => planOpen('https://x.y', ['--incognito'], probe), ArgError);
  });
  it('app bundles and names use open -a with --args', () => {
    assert.deepEqual(planOpen('/Applications/Safari.app', ['-private'], probe).args, ['-a', '/Applications/Safari.app', '--args', '-private']);
    assert.deepEqual(planOpen('Safari', undefined, probe).args, ['-a', 'Safari']);
    assert.deepEqual(planOpen('chrome', ['--incognito', 'https://x.y'], probe).args, ['-a', 'Google Chrome', '--args', '--incognito', 'https://x.y']);
    assert.deepEqual(planOpen('notepad', undefined, probe).args, ['-a', 'TextEdit']);
    assert.deepEqual(planOpen('Google Chrome.app', undefined, probe).args, ['-a', 'Google Chrome']);
  });
  it('folders, documents and executables', () => {
    assert.deepEqual(planOpen('~/Documents', undefined, probe).args, ['/Users/me/Documents']);
    assert.equal(planOpen('~/notes.txt', undefined, probe).kind, 'file');
    assert.equal(planOpen('~/report.pdf', undefined, probe).kind, 'file'); // x-bit on a document is not a program
    const exe = planOpen('/usr/local/bin/tool', ['--flag', 'a b'], probe);
    assert.deepEqual(exe, { kind: 'executable', file: '/usr/local/bin/tool', args: ['--flag', 'a b'], spawn: true });
    assert.equal(planOpen('~/run.sh', undefined, probe).spawn, true);
    assert.throws(() => planOpen('~/notes.txt', ['x'], probe), ArgError);
    assert.throws(() => planOpen('/nope/missing', undefined, probe), /not found/);
  });
  it('expands ~', () => {
    assert.equal(expandHome('~/x', '/Users/me'), '/Users/me/x');
    assert.equal(expandHome('~', '/Users/me'), '/Users/me');
    assert.equal(expandHome('/a', '/Users/me'), '/a');
  });
});
