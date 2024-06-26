import json
import sys
import requests
import os

SCRIPT_DIR = os.path.dirname(os.path.realpath(__file__))


def get_location(hostname):
    request = requests.head(f"http://{hostname}")
    location = request.headers.get("x-amz-cf-pop")
    if location is None:
        return ""
    return location


def check_neighbor(location_lower, neighbors):
    if neighbors is None:
        return False
    for neighbor in neighbors:
        if location_lower.startswith(neighbor.lower()):
            return True
    return False


def main():
    domain = sys.argv[1]
    if not domain:
        print("Usage: python check_endpoint.py <domain>")
        sys.exit(1)

    with open(os.path.join(SCRIPT_DIR, "pop.json")) as f:
        pops = json.load(f)

    for pop in pops:
        code = pop["code"]
        code_lower = code.lower()
        location = get_location(f"{code_lower}.{domain}")
        location_lower = location.lower()
        if location_lower.startswith(code_lower):
            print(f"{code} is OK")
        else:
            if check_neighbor(location_lower, pop.get("neighbors")):
                print(f"{code} is in {location} which is a neighbor")
            else:
                print(f"{code} gets unexpected location {location}")


if __name__ == "__main__":
    main()
