import json


def main():
    with open("pop_all.json") as f:
        pops = json.load(f)
    results = []
    for pop in pops:
        subnet = pop.get("subnet")
        code = pop.get("code")
        if subnet is not None and code is not None:
            results.append(
                {
                    "id": pop["id"],
                    "location": pop["location"],
                    "country": pop["country"],
                    "subnet": subnet,
                    "code": code,
                }
            )
        elif subnet is not None or code is not None:
            print(f"Warning: {pop['name']} has only subnet or code")
    results.sort(key=lambda x: x["id"])
    with open("pop.json", "w") as f:
        json.dump(results, f, indent=2)


if __name__ == "__main__":
    main()
