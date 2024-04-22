import * as fs from 'fs';

import { Client as AdbClient, DeviceClient } from '@devicefarmer/adbkit';
import * as FridaJs from 'frida-js';

import { getConnectedDevices, getRootCommand, isProbablyRooted } from '../android/adb-commands';
import { waitUntil } from '../../util/promise';
import { buildAndroidFridaScript } from './frida-scripts';

/**
 * Terminology:
 * - FridaHost: a device which may contain 1+ Frida targets
 * - FridaTarget: a single app that can be intercepted
 **/

export interface FridaHost {
    id: string;
    name: string;
    type: string;
    state:
        | 'unavailable' // Probably not Frida compatible (e.g. not rooted)
        | 'setup-required' // Probably compatible but Frida not installed
        | 'launch-required' // Frida installed, should work if launched
        | 'available', // Frida seems to be running & ready right now
    targets?: FridaTarget[]
}

export interface FridaTarget {
    id: string;
    name: string;
}

const FRIDA_DEFAULT_PORT = 27042;
const FRIDA_ALTERNATE_PORT = 24072; // Reversed to mildly inconvenience detection

const FRIDA_VERSION = '16.1.7';

const ANDROID_DEVICE_HTK_PATH = '/data/local/tmp/.httptoolkit';
const FRIDA_BINARY_NAME = `adirf-server`; // Reversed to mildly inconvenience detection
const FRIDA_BINARY_PATH = `${ANDROID_DEVICE_HTK_PATH}/${FRIDA_BINARY_NAME}`;

const ALL_X_PERMS = 0o00111;

const isFridaInstalled = (deviceClient: DeviceClient) =>
    deviceClient.readdir(ANDROID_DEVICE_HTK_PATH)
    .then((entries) => entries.some((entry) =>
        entry.name === FRIDA_BINARY_NAME &&
        (entry.mode & ALL_X_PERMS) !== 0
    ))
    .catch(() => false);

const isDevicePortOpen = (deviceClient: DeviceClient, port: number) =>
    deviceClient.openTcp(port).then((conn) => {
        // If the connection opened at all, then something is listening...
        conn.on('error', () => {});
        conn.end();
        return true;
    }).catch(() => {
        // If the port is closed, we jump straight to the error state instead
        return false
    });

export async function getAndroidFridaHosts(adbClient: AdbClient): Promise<FridaHost[]> {
    const devices = await getConnectedDevices(adbClient);

    const result = await Promise.all(
        devices.map((deviceId) => getHostStatus(adbClient, deviceId)
    ));

    return result;
}

const getHostStatus = async (adbClient: AdbClient, deviceId: string) => {
    const deviceClient = adbClient.getDevice(deviceId);

    let state: FridaHost['state'] = 'unavailable';

    // We run state checks in series, not parallel - slower, but less hammering of
    // ADB APIs & device processing, and no running any unnecessary checks.

    const [defaultPortOpen, alternatePortOpen] = await Promise.all([
        isDevicePortOpen(deviceClient, FRIDA_DEFAULT_PORT),
        isDevicePortOpen(deviceClient, FRIDA_ALTERNATE_PORT)
    ]);

    if (defaultPortOpen || alternatePortOpen) {
        state = 'available';
    } else if (await isFridaInstalled(deviceClient)) {
        state = 'launch-required'
    } else if (await isProbablyRooted(deviceClient)) {
        state = 'setup-required'
    } else {
        // No Frida - looks unrooted - nothing we can do.
        state = 'unavailable';
    }

    return {
        id: deviceId,
        name: deviceId,
        type: 'android',
        state
    } as const;
};

const ABI_ARCH_MAP = {
    'arm64-v8a': 'arm64',
    'armeabi': 'arm',
    'armabi-v7a': 'arm',
    'x86': 'x86',
    'x86_64': 'x86_64'
} as const;

export async function setupAndroidHost(adbClient: AdbClient, hostId: string) {
    const deviceClient = adbClient.getDevice(hostId);

    const deviceProperties = await deviceClient.getProperties();
    const supportedAbis = (
        deviceProperties['ro.product.cpu.abilist']?.split(',') ??
        [deviceProperties['ro.product.cpu.abi']]
    ).map(abi => abi.trim());

    const firstKnownAbi = supportedAbis.find((abi): abi is keyof typeof ABI_ARCH_MAP =>
        Object.keys(ABI_ARCH_MAP).includes(abi)
    );
    if (!firstKnownAbi) throw new Error(`Did not recognize any device ABIs from ${supportedAbis.join(',')}`);

    const deviceArch = ABI_ARCH_MAP[firstKnownAbi];

    const serverStream = await FridaJs.downloadFridaServer({
        version: FRIDA_VERSION,
        platform: 'android',
        arch: deviceArch
    });

    await deviceClient.push(serverStream, FRIDA_BINARY_PATH, 0o555);
}

export async function launchAndroidHost(adbClient: AdbClient, hostId: string) {
    const deviceClient = adbClient.getDevice(hostId);

    const runAsRoot = await getRootCommand(deviceClient);

    if (!runAsRoot) {
        throw new Error("Couldn't get root access to launch Frida Server");
    }

    const fridaServerStream = await deviceClient.shell(
        runAsRoot(FRIDA_BINARY_PATH, '-l', `127.0.0.1:${FRIDA_ALTERNATE_PORT}`)
    );
    fridaServerStream.pipe(process.stdout);
    // TODO: This stream (TCP connection) is what keeps Frida alive - need to think about management

    // Wait until the server becomes accessible
    try {
        await waitUntil(500, 10, async () => {
            try {
                const status = await getHostStatus(adbClient, hostId);
                return status.state === 'available';
            } catch (e: any) {
                console.log(e.message ?? e);
                return false;
            }

        });
    } catch (e: any) {
        console.log(e.message ?? e);
        throw new Error(`Failed to launch Frida server for ${hostId}`);
    }
}

export async function getAndroidFridaTargets(adbClient: AdbClient, hostId: string) {
    const deviceClient = adbClient.getDevice(hostId);

     // Try alt port first (preferred and more likely to work - it's ours)
     const fridaStream = await deviceClient.openTcp(FRIDA_ALTERNATE_PORT)
     .catch(() => deviceClient.openTcp(FRIDA_DEFAULT_PORT));

    const fridaSession = await FridaJs.connect({
        stream: fridaStream
    });

    const apps = await fridaSession.enumerateApplications();
    fridaSession.disconnect();
    return apps;
}

export async function interceptAndroidFridaTarget(
    adbClient: AdbClient,
    hostId: string,
    appId: string,
    caCertContent: string,
    proxyPort: number
) {
    const deviceClient = adbClient.getDevice(hostId);

    // Try alt port first (preferred and more likely to work - it's ours)
    const fridaStream = await deviceClient.openTcp(FRIDA_ALTERNATE_PORT)
        .catch(() => deviceClient.openTcp(FRIDA_DEFAULT_PORT));

    const fridaSession = await FridaJs.connect({
        stream: fridaStream
    });

    const script = await buildAndroidFridaScript(
        caCertContent,
        '10.0.0.102', // TODO: '127.0.0.1' + port forwarding?
        proxyPort
    );

    await fridaSession.spawnWithScript(appId, undefined, script); // TODO: Work out HTF we can receive errors here, so annoying. 'Signals'???
}

// TODO: Do we combine iOS and Android here, or separate them?
// Logic is different but some shared components. Maybe they should both be in the same folder
// but different interceptors, so we'd show "Android Device via Frida", "iOS Device via Frida",
// "Local Frida target" (much much later, don't try to do local now! No working scripts)

// export async function getPotentialFridaHosts(): FridaHost[] {
//     /*
//     TODO: For android:
//     - Connect to ADB
//     - Get all devices
//     - For each device, work out if Frida is running
//         Check port on device? 27042 (+24072?)
//     - For each device where it's not, work out if Frida _could be_ running
//         Check out magic path? /data/local/tmp/.httptoolkit/adirf-server

//     "getprop ro.product.model" for name
//     */

//     /*
//     TODO: For iOS:
//     - Use usbmux protocol (somehow) to talk to local USBMUXD
//         port 27015 on windows
//         itunes at /var/run/usbmuxd on Mac (and Linux?)
//         See also USBMUXD_SOCKET_ADDRESS
//     - Use https://github.com/DeMille/node-usbmux/blob/master/lib/usbmux.js or similar
//     - Scan for ports somehow
//     - If known Frida port is live, we're golden.
//     */

//     return [];
// }