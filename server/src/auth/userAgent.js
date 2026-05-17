/**
 * Tiny user-agent fingerprinter. Returns `{ os, browser, device_type }`
 * derived from the raw UA string. Designed for the forensic-log path: not
 * exhaustive, but stable enough to group attempts by attacker across
 * obvious browser families. Never throws — unknown UAs return blanks.
 */

function detect(ua) {
  if (typeof ua !== 'string' || ua.length === 0) {
    return { os: '', browser: '', device_type: '' };
  }

  // OS detection. Order matters: Android UAs contain "Linux", iPadOS pretends
  // to be Mac, etc. The most specific tokens are checked first.
  let os = '';
  if (/Windows NT 10\.0/i.test(ua))              os = 'Windows 10/11';
  else if (/Windows NT 6\.3/i.test(ua))          os = 'Windows 8.1';
  else if (/Windows NT 6\.[0-2]/i.test(ua))      os = 'Windows 7/8';
  else if (/Windows/i.test(ua))                  os = 'Windows';
  else if (/Android\s+(\d+(?:\.\d+)?)/i.test(ua)) os = `Android ${RegExp.$1}`;
  else if (/Android/i.test(ua))                  os = 'Android';
  else if (/iPad|iPhone|iPod/i.test(ua)) {
    const m = ua.match(/OS\s+(\d+[_\.]\d+)/i);
    os = m ? `iOS ${m[1].replace('_', '.')}` : 'iOS';
  }
  else if (/Mac OS X\s+(\d+[_\.]\d+(?:[_\.]\d+)?)/i.test(ua)) os = `macOS ${RegExp.$1.replace(/_/g, '.')}`;
  else if (/Macintosh|Mac OS X/i.test(ua))       os = 'macOS';
  else if (/CrOS/i.test(ua))                     os = 'ChromeOS';
  else if (/FreeBSD|OpenBSD|NetBSD/i.test(ua))   os = 'BSD';
  else if (/Linux/i.test(ua))                    os = 'Linux';

  // Browser detection. Order matters: Edge contains "Chrome", Opera contains
  // "Chrome", Chrome contains "Safari", Safari contains nothing special. We
  // check the more specific brands first.
  let browser = '';
  if (/Edg\/[\d.]+/.test(ua))                          browser = `Edge ${(ua.match(/Edg\/([\d.]+)/) || [])[1] || ''}`.trim();
  else if (/OPR\/[\d.]+|Opera/.test(ua))               browser = `Opera ${(ua.match(/OPR\/([\d.]+)/) || [])[1] || ''}`.trim();
  else if (/Vivaldi\/[\d.]+/.test(ua))                 browser = `Vivaldi ${(ua.match(/Vivaldi\/([\d.]+)/) || [])[1] || ''}`.trim();
  else if (/Brave\/[\d.]+/.test(ua))                   browser = `Brave ${(ua.match(/Brave\/([\d.]+)/) || [])[1] || ''}`.trim();
  else if (/SamsungBrowser\/[\d.]+/.test(ua))          browser = `Samsung Internet ${(ua.match(/SamsungBrowser\/([\d.]+)/) || [])[1] || ''}`.trim();
  else if (/Firefox\/[\d.]+/.test(ua))                 browser = `Firefox ${(ua.match(/Firefox\/([\d.]+)/) || [])[1] || ''}`.trim();
  else if (/Chrome\/[\d.]+/.test(ua))                  browser = `Chrome ${(ua.match(/Chrome\/([\d.]+)/) || [])[1] || ''}`.trim();
  else if (/Version\/[\d.]+.*Safari/.test(ua))         browser = `Safari ${(ua.match(/Version\/([\d.]+)/) || [])[1] || ''}`.trim();
  else if (/Safari/.test(ua))                          browser = 'Safari';
  else if (/curl|wget|HTTPie|Postman|Insomnia/i.test(ua)) browser = ua.split(/[\s\/]/)[0];

  // Device-type heuristics. "Mobile" and "Tablet" tokens are the standard
  // signals; the iPad case has to be carved out separately because Apple
  // dropped "Mobile" from iPad UAs in iPadOS 13+.
  let deviceType = '';
  if (/Mobile|iPhone|iPod|Android.*Mobile/i.test(ua))  deviceType = 'Mobile';
  else if (/iPad|Tablet|Android(?!.*Mobile)/i.test(ua))deviceType = 'Tablet';
  else if (/Windows|Macintosh|Mac OS X|Linux|CrOS/i.test(ua)) deviceType = 'Desktop';
  else if (/Capacitor|CFNetwork/i.test(ua))            deviceType = 'Native app';

  return {
    os,
    browser,
    device_type: deviceType,
  };
}

module.exports = { detect };
