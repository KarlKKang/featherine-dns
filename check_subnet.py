import json
import sys
import subprocess
import ipaddress


def inverse_lookup(ip):
    p = subprocess.run(
        ["dig", "-x", ip, "+short"], check=True, capture_output=True, text=True
    )
    return p.stdout.strip()


def dns_lookup(domain, subnet):
    p = subprocess.run(
        ["dig", "@8.8.8.8", domain, "A", "+short", "+subnet=" + subnet],
        check=True,
        capture_output=True,
        text=True,
    )
    for line in p.stdout.splitlines():
        try:
            ipaddress.ip_address(line)
        except ValueError:
            continue
        return line
    return None


def main():
    domain = sys.argv[1]
    if not domain:
        print("Usage: python check_subnet.py <domain>")
        sys.exit(1)

    with open("pop.json") as f:
        pops = json.load(f)

    for pop in pops:
        subnet = pop["subnet"]
        code = pop["code"]
        ip = dns_lookup(domain, subnet)
        if ip is None:
            raise ValueError(f"Cannot find IP address for {code}")
        dns_name = inverse_lookup(ip)
        dns_name_prefix = "server-" + ip.replace(".", "-") + "." + code.lower()
        if dns_name.startswith(dns_name_prefix):
            print(f"{code} is OK")
        else:
            raise ValueError(f"{code} gets unexpected DNS name {dns_name}")


if __name__ == "__main__":
    main()
