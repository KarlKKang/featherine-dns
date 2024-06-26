import json
import sys
import subprocess
import ipaddress
import os

SCRIPT_DIR = os.path.dirname(os.path.realpath(__file__))


def inverse_lookup(ip):
    p = subprocess.run(["dig", "-x", ip, "+short"], capture_output=True, text=True)
    if p.returncode != 0:
        return ""
    return p.stdout.strip()


def dns_lookup(domain, subnet):
    p = subprocess.run(
        ["dig", "@8.8.8.8", domain, "A", "+short", "+subnet=" + subnet],
        capture_output=True,
        text=True,
    )
    if p.returncode != 0:
        return None
    for line in p.stdout.splitlines():
        try:
            ipaddress.ip_address(line)
        except ValueError:
            continue
        return line
    return None


def check_neighbor(dns_name, dns_name_prefix_ip, neighbors):
    if neighbors is None:
        return False
    for neighbor in neighbors:
        if dns_name.startswith(dns_name_prefix_ip + neighbor.lower()):
            return True
    return False


def main():
    domain = sys.argv[1]
    if not domain:
        print("Usage: python check_subnet.py <domain>")
        sys.exit(1)

    with open(os.path.join(SCRIPT_DIR, "pop.json")) as f:
        pops = json.load(f)

    for pop in pops:
        subnet = pop["subnet"]
        code = pop["code"]
        ip = dns_lookup(domain, subnet)
        if ip is None:
            print(f"Cannot find IP address for {code}")
        dns_name = inverse_lookup(ip)
        dns_name_prefix_ip = "server-" + ip.replace(".", "-") + "."
        dns_name_prefix = dns_name_prefix_ip + code.lower()
        if dns_name.startswith(dns_name_prefix):
            print(f"{code} is OK")
        else:
            if check_neighbor(dns_name, dns_name_prefix_ip, pop.get("neighbors")):
                print(f"{code} gets DNS name {dns_name} which is a neighbor")
            else:
                print(f"{code} gets unexpected DNS name {dns_name}")


if __name__ == "__main__":
    main()
