'use strict';

/**
 * Packaging-time executable allowlist.
 *
 * Every downloaded or copied executable must match both the exact byte length
 * and SHA-256 below before it can enter an Electron release. Updating a package
 * version therefore intentionally requires a reviewed manifest update too.
 */
module.exports = Object.freeze({
  schemaVersion: 1,
  allowedDownloadHosts: Object.freeze([
    'github.com',
    'release-assets.githubusercontent.com',
  ]),
  mediasoup: Object.freeze({
    packageVersion: '3.26.0',
    targets: Object.freeze({
      'darwin-arm64': Object.freeze({
        binaryName: 'mediasoup-worker',
        archiveName: 'mediasoup-worker-3.26.0-darwin-arm64.tgz',
        archive: Object.freeze({
          size: 2621228,
          sha256: '9615f6327a2c7c0a101d57a952b73fee5996f337b43b5958779d44caa09e1f5a',
        }),
        binary: Object.freeze({
          size: 6732672,
          sha256: 'ea9c500e2bd3eaead6f4c28ea068fcc7bf800ce363b7160f3bb93477a32a02ab',
        }),
      }),
      'win32-x64': Object.freeze({
        binaryName: 'mediasoup-worker.exe',
        archiveName: 'mediasoup-worker-3.26.0-win32-x64.tgz',
        archive: Object.freeze({
          size: 2057161,
          sha256: '286be1d187ae64756ee552e91857f72dbe55af7f6ef7d20d801a7c5ee78ee895',
        }),
        binary: Object.freeze({
          size: 5373440,
          sha256: '7a32123f3c268fbdfda8bfa3b37c165a64088037f09f17e6b25c2d9f636a8c05',
        }),
      }),
    }),
  }),
  ffmpegStatic: Object.freeze({
    packageVersion: '5.3.0',
    releaseTag: 'b6.1.1',
    targets: Object.freeze({
      'darwin-arm64': Object.freeze({
        binaryName: 'ffmpeg',
        binary: Object.freeze({
          size: 45568216,
          sha256: 'a90e3db6a3fd35f6074b013f948b1aa45b31c6375489d39e572bea3f18336584',
        }),
      }),
      'win32-x64': Object.freeze({
        binaryName: 'ffmpeg.exe',
        binary: Object.freeze({
          size: 82797568,
          sha256: '04e1307997530f9cf2fe35cba2ca7e8875ca91da02f89d6c7243df819c94ad00',
        }),
      }),
    }),
  }),
  ffprobeStatic: Object.freeze({
    packageVersion: '3.1.0',
    targets: Object.freeze({
      'darwin-arm64': Object.freeze({
        binaryName: 'ffprobe',
        binary: Object.freeze({
          size: 76519264,
          sha256: '5b592e56f87ff754d94dadf99f38b4d0fb7d463eb780b50e0ca061d668d0e3f7',
        }),
      }),
      'win32-x64': Object.freeze({
        binaryName: 'ffprobe.exe',
        binary: Object.freeze({
          size: 63059968,
          sha256: '4303ec85855340689b1f8aa5d9c1dc06ef3e3090682de3034edc3fca2b0798d5',
        }),
      }),
    }),
  }),
});
