import requests
import json


def is_pop(tags):
    for tag in tags:
        if tag["name"] == "Edge Locations":
            return True
    return False


def main():
    existing_pops = []
    try:
        with open("pop.json") as f:
            existing_pops = json.load(f)
    except FileNotFoundError:
        pass
    existing_pops_dict = {}
    for existing_pop in existing_pops:
        existing_pops_dict[existing_pop["id"]] = existing_pop
    result = requests.get(
        "https://aws.amazon.com/api/dirs/items/search?item.directoryId=cf-map-pins&size=500&item.locale=ja_JP"
    )
    result.raise_for_status()
    result = result.json()
    if result["metadata"]["count"] > 500:
        print("Warning: count > 500")
    pops = []
    for item in result["items"]:
        if is_pop(item["tags"]):
            item = item["item"]
            addtional_fields = item["additionalFields"]
            pops.append(
                {
                    "id": item["id"],
                    "name": item["name"],
                    "location": addtional_fields["pinName"],
                    "country": addtional_fields["pinDescription"],
                }
            )
    for pop in pops:
        pop_id = pop["id"]
        if not pop_id.startswith("cf-map-pins#"):
            print(f"Warning: {pop['name']} has invalid id")
            continue
        pop_id = pop_id[len("cf-map-pins#") :]
        pop["id"] = pop_id
        existing_pop = existing_pops_dict.get(pop_id)
        if existing_pop is not None:
            pop["subnet"] = existing_pop["subnet"]
            pop["code"] = existing_pop["code"]
    with open("pop_all.json", "w") as f:
        json.dump(pops, f, indent=2)


if __name__ == "__main__":
    main()
