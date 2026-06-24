import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { env } from 'node:process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { type as osType } from 'node:os'
const currentDir = dirname(fileURLToPath(import.meta.url))
const libDir = join(currentDir, 'lib')
const quickjsDir = join(currentDir, 'quickjs')
const toolchainDir = join(currentDir, 'toolchains')
const quickjsRepository = 'https://github.com/quickjs-ng/quickjs.git'
const zigToolchainRepo = 'https://github.com/starofrainnight/zig-cmake-toolchains.git'

/**
 * @typedef BuildParams
 * @property {string} target
 * @property {string} buildDir
 * @property {string[]} configureCommands
 * @property {string[]} buildCommands
 */

async function checkoutGitRepo(repo, dir) {
    if (existsSync(join(dir, '.git'))) {
        await runCommand(['git', 'pull'], dir)
    } else {
        await runCommand(['git', 'clone', '--depth', '1', repo, dir], currentDir)
    }
}

async function checkoutTools() {
    await checkoutGitRepo(quickjsRepository, quickjsDir)
    await checkoutGitRepo(zigToolchainRepo, toolchainDir)
}

function readEnvVar(name, required = false) {
    const v = env[name]
    if (!v && required) {
        throw new Error(`environment variable ${name} is required`)
    }
    return v
}

function findNdk(targetVersion = '27') {
    const ndkNames = ['ANDROID_NDK', 'ANDROID_NDK_ROOT', 'ANDROID_NDK_ROOT', 'ANDROID_NDK_HOME', 'ANDROID_NDK_LATEST_HOME']
    for (const name of ndkNames) {
        const path = readEnvVar(name)
        if (!path) {
            continue
        }
        if (existsSync(path)) {
            return path
        }
        console.warn(`environment variable ${name} has value "${path}", but the path isn't exists`)
    }
    const sdkNames = ['ANDROID_HOME', 'ANDROID_SDK_ROOT']
    console.warn(`cannot find ndk through the following environment variables: ${ndkNames.join(', ')}.`);
    console.warn(`Start find Android sdk through the following environment variables: ${sdkNames.join(', ')}.`);
    for (const name of sdkNames) {
        const sdkPath = readEnvVar(name)
        if (!sdkPath) {
            continue
        }
        if (!existsSync(sdkPath)) {
            console.warn(`environment variable ${name} has value "${sdkPath}", but the path isn't exists`)
        }
        const ndkDir = join(sdkPath, 'ndk')
        /** @type {string[]} */
        let ndkVersions = []
        try {
            ndkVersions = readdirSync(ndkDir)
        } catch (error) {
        }
        let maxVersion = ''
        for (const version of ndkVersions) {
            const versionPath = join(sdkPath, 'ndk', version)
            if (!statSync(versionPath).isDirectory()) {
                continue
            }
            if (targetVersion && targetVersion === version || version.startsWith(`${targetVersion}.`)) {
                return versionPath
            }
            if (!maxVersion || version > maxVersion) {
                maxVersion = version
            }
        }
        if (maxVersion) {
            return join(ndkDir, maxVersion)
        }
    }
    throw new Error('cannot find ndk')

}

function normalizePath(path) {
    return path.split('\\').join('/')
}

async function buildProject() {
    await checkoutTools()
    const zigTargets = {
        'windows-x64': 'zig-toolchain-x86_64-windows-gnu',
        'linux-x64': 'zig-toolchain-x86_64-linux-gnu',
        'linux-arm64': 'zig-toolchain-aarch64-linux-gnu'
    }

    const androidTargets = {
        'android-x86': 'x86',
        'android-x64': 'x86_64',
        'android-arm32': 'armeabi-v7a',
        'android-arm64': 'arm64-v8a'
    }
    /**
     * @type {Record<string, {arch:string;sys:string;}>}
     */
    const iosTargets = {
        'ios-arm64': { arch: 'arm64', sys: 'iphoneos' },
        'ios-sim-arm64': { arch: 'arm64', sys: 'iphonesimulator' },
        'ios-x64': { arch: 'x86_64', sys: 'iphonesimulator' }
    }
    const macOsTargets = {
        'macos-x64': 'x86_64',
        'macos-aarch64': 'arm64'
    }
    /**
     * @type {'Linux'| 'Darwin' | 'Windows_NT'}
     */
    const type = osType()
    if (type !== 'Darwin') {
        console.log(`current host system is ${type}, will ignore apple targets`);
    }
    /**
     * @type {BuildParams[]}
     */
    const buildParams = []
    const ndkPath = normalizePath(findNdk())
    for (const target in zigTargets) {
        const buildDir = 'build/' + target
        buildParams.push({
            target,
            buildDir,
            configureCommands: ['cmake', '-G', 'Ninja', '-S', '.', '-B', buildDir, '-DCMAKE_BUILD_TYPE=Release', '-DCMAKE_TOOLCHAIN_FILE=' + normalizePath(join(toolchainDir, zigTargets[target] + '.cmake'))],
            buildCommands: ['cmake', '--build', buildDir, '--target', 'qjs']
        })
    }
    for (const target in androidTargets) {
        const buildDir = 'build/' + target
        buildParams.push({
            target: target,
            buildDir: buildDir,
            configureCommands: ['cmake', '-G', 'Ninja', '-S', '.', '-B', buildDir, `-DCMAKE_TOOLCHAIN_FILE=${ndkPath}/build/cmake/android.toolchain.cmake`, `-DANDROID_ABI=${androidTargets[target]}`, '-DCMAKE_BUILD_TYPE=Release'],
            buildCommands: ['cmake', '--build', buildDir, '--target', 'qjs']
        })
    }
    if (type === 'Darwin') {
        for (const target in iosTargets) {
            const buildDir = 'build/' + target
            const { arch, sys } = iosTargets[target]
            buildParams.push({
                target: target,
                buildDir: buildDir,
                configureCommands: ['cmake', '-S', '.', '-B', buildDir, '-DCMAKE_BUILD_TYPE=Release', '-DCMAKE_OSX_ARCHITECTURES=' + arch, '-DCAMKE_SYSTEM_NAME=iOS', '-DCMAKE_OSX_SYSROOT=' + sys],
                buildCommands: ['cmake', '--build', buildDir, '--target', 'qjs']
            })
        }
        for (const target in macOsTargets) {
            const buildDir = 'build/' + target
            buildParams.push({
                target: target,
                buildDir: buildDir,
                configureCommands: ['cmake', '-S', '.', '-B', buildDir, '-DCMAKE_BUILD_TYPE=Release', '-DCMAKE_OSX_ARCHITECTURES=' + macOsTargets[target]],
                buildCommands: ['cmake', '--build', buildDir, '--target', 'qjs']
            })
        }
    }
    for (const params of buildParams) {
        await runCommand(params.configureCommands, quickjsDir)
        await runCommand(params.buildCommands, quickjsDir)
    }
    copyLibFile('qjs', buildParams)
}

/**
 *
 * @param {string} fileName
 * @param {BuildParams[]} params
 */
function copyLibFile(libName, params) {
    if (!existsSync(libDir)) {
        mkdirSync(libDir)
    }
    const prefixes = ['lib' + libName, libName]
    const suffixes = ['.lib', '.a', '.dylib', '.so', '.dll']
    for (const { buildDir, target } of params) {
        for (const prefix of prefixes) {
            for (const suf of suffixes) {
                const fileName = prefix + suf
                const filePath = join(quickjsDir, buildDir, fileName)
                if (existsSync(filePath)) {
                    const extName = fileName.substring(fileName.lastIndexOf('.'))
                    copyFileSync(filePath, join(libDir, 'lib' + libName + '-' + target + extName))
                }
            }
        }
    }
}

async function runCommand(args, cwd) {
    const isWin = osType().startsWith('Windows')
    const cmd = isWin ? 'cmd.exe' : 'bash'
    console.log(args.join(' '));
    return new Promise((resolve, reject) => {
        const options = cwd ? { cwd } : undefined
        const p = spawn(cmd, [isWin ? '/c' : '-c', args.join(' ')], options)
        p.stdout.on('data', data => console.log(data.toString().trim()));
        p.stderr.on('data', data => console.error(data.toString().trim()));
        p.on('close', code => {
            if (code === 0) {
                resolve()
            } else {
                reject(new Error('exit code: ' + code))
            }
        })
    });
}


buildProject()
