import subprocess
import re
import time
from typing import Optional, List, Tuple

ADB_PATH = r"adb"  # đổi thành "adb" nếu adb đã có trong PATH

SERIALS = [
    '52003453f40ab427',
    '9885e64b5333363439',
    '98867850453235524f',
    'ad09160358d7a8da80',
    'ce0117115968e4320c',
    'ce02160224a8852704',
    'ce02160238af3c0202',
    'ce0316039575ad4004',
    'ce031603b573891a02',
    'ce041604282aef1905',
    'ce0416044c28193605',
    'ce06160622c5931003',
    'ce06160691cdc91f04',
    'ce0816089c51db0b02',
    'ce09160959b6913c02',
    'ce10160a29adae3d03',
    'ce11160b2cd6713e05',
    'ce11160b71544c1904',
    'ce12160c3bdd872604',
    'ce12160cebf0c92f01'
]

BASE_PORT = 5555  # mỗi thiết bị tăng 1 port: 5551, 5552, 5553...

# ---- Regex helpers ----
# ip route get ... -> "src 192.168.1.166"
IP_ROUTE_SRC_REGEX = re.compile(r"\bsrc\s+(\d+\.\d+\.\d+\.\d+)\b")

# ip -f inet addr show ... -> "inet 192.168.1.166/24"
IP_ADDR_INET_REGEX = re.compile(r"\binet\s+(\d+\.\d+\.\d+\.\d+)/\d+\b")

# ifconfig -> "inet addr:192.168.1.166" OR "inet 192.168.1.166"
IFCONFIG_IPV4_REGEX = re.compile(r"\binet\s+addr:\s*(\d+\.\d+\.\d+\.\d+)\b")
IFCONFIG_IPV4_ALT_REGEX = re.compile(r"\binet\s+(\d+\.\d+\.\d+\.\d+)\b")


def run_cmd(args: List[str], timeout: int = 30) -> Tuple[int, str, str]:
    """Run command and return (returncode, stdout, stderr)."""
    p = subprocess.run(
        args,
        capture_output=True,
        text=True,
        timeout=timeout,
        shell=False,
    )
    return p.returncode, (p.stdout or "").strip(), (p.stderr or "").strip()


def adb(args: List[str], timeout: int = 30) -> Tuple[int, str, str]:
    return run_cmd([ADB_PATH] + args, timeout=timeout)


def get_device_state(serial: str) -> str:
    rc, out, err = adb(["-s", serial, "get-state"], timeout=10)
    if rc == 0 and out:
        return out.strip()
    return (out or err or "unknown").strip()


def _pick_ipv4(text: str) -> Optional[str]:
    """Extract first IPv4 (non-127.0.0.1) from a text using known patterns."""
    for rgx in (IP_ROUTE_SRC_REGEX, IP_ADDR_INET_REGEX, IFCONFIG_IPV4_REGEX, IFCONFIG_IPV4_ALT_REGEX):
        m = rgx.search(text or "")
        if m:
            ip = m.group(1)
            if ip and ip != "127.0.0.1":
                return ip
    return None


def _extract_iface_block(ifconfig_text: str, iface: str) -> Optional[str]:
    """
    Extract a block of an interface from ifconfig output.
    Block starts at line beginning with iface, ends before next non-indented header line.
    """
    if not ifconfig_text:
        return None

    # Example headers: "wlan0     Link encap:UNSPEC"
    # Following lines are indented.
    pattern = re.compile(rf"^(?:{re.escape(iface)})\b[\s\S]*?(?=^\S|\Z)", re.MULTILINE)
    m = pattern.search(ifconfig_text)
    return m.group(0) if m else None


def get_device_ip(serial: str, retries: int = 4, delay_sec: float = 0.8) -> Optional[str]:
    """
    Lấy IPv4 robust:
    1) ip route get 1.1.1.1 (ổn nhất)
    2) ip -f inet addr show wlan0/eth0
    3) ifconfig wlan0/eth0
    4) ifconfig (full) -> parse block wlan0/eth0
    Có retry vì đôi khi adbd/iface trả rỗng trong chốc lát.
    """
    for _ in range(retries):
        # 1) Best: ip route get -> src x.x.x.x
        rc, out, err = adb(["-s", serial, "shell", "ip", "route", "get", "1.1.1.1"], timeout=10)
        ip = _pick_ipv4(out) if rc == 0 else None
        if ip:
            return ip

        # 2) ip addr show per iface
        for iface in ("wlan0", "eth0"):
            rc, out, err = adb(["-s", serial, "shell", "ip", "-f", "inet", "addr", "show", iface], timeout=12)
            ip = _pick_ipv4(out) if rc == 0 else None
            if ip:
                return ip

        # 3) ifconfig per iface
        for iface in ("wlan0", "eth0"):
            rc, out, err = adb(["-s", serial, "shell", "ifconfig", iface], timeout=12)
            ip = _pick_ipv4(out) if rc == 0 else None
            if ip:
                return ip

        # 4) ifconfig full -> parse blocks
        rc, out, err = adb(["-s", serial, "shell", "ifconfig"], timeout=15)
        if rc == 0 and out:
            for iface in ("wlan0", "eth0"):
                block = _extract_iface_block(out, iface)
                ip = _pick_ipv4(block or "")
                if ip:
                    return ip

        time.sleep(delay_sec)

    return None


def enable_tcpip(serial: str, port: int) -> Tuple[bool, str]:
    rc, out, err = adb(["-s", serial, "tcpip", str(port)], timeout=20)
    msg = out or err
    ok = rc == 0
    return ok, msg


def adb_connect(ip: str, port: int) -> Tuple[bool, str]:
    rc, out, err = adb(["connect", f"{ip}:{port}"], timeout=20)
    msg = out or err
    lowered = msg.lower()
    ok = ("connected to" in lowered) or ("already connected" in lowered)
    return ok, msg


def main():
    adb(["kill-server"], timeout=10)
    adb(["start-server"], timeout=10)

    print(f"ADB: {ADB_PATH}")
    print(f"Total serials: {len(SERIALS)}")
    print("-" * 60)

    for idx, s in enumerate(SERIALS):
        port = BASE_PORT  # 5551, 5552, ...

        print(f"== {s} ==")
        print(f"  assigned port: {port}")

        state = get_device_state(s)
        print(f"  state: {state}")

        if state != "device":
            print("  !! Thiết bị không ở trạng thái 'device' (có thể unauthorized/offline). Bỏ qua.\n")
            continue

        # LẤY IP TRƯỚC KHI tcpip (tránh adbd restart làm shell fail)
        ip = get_device_ip(s)
        if not ip:
            print("  !! Không lấy được IPv4 (ip route/ip addr/ifconfig). Bỏ qua.\n")
            continue
        print(f"  ip: {ip}")

        ok, msg = enable_tcpip(s, port)
        print(f"  tcpip {port}: {'OK' if ok else 'FAIL'} | {msg}")

        # Sau tcpip, đợi chút cho adbd ổn định
        time.sleep(0.8)

        ok, msg = adb_connect(ip, port)
        print(f"  connect {ip}:{port}: {'OK' if ok else 'FAIL'} | {msg}\n")

    print("Done.")


if __name__ == "__main__":
    main()
