# Crowd Missions

A [WebODM](https://github.com/WebODM/WebODM) plugin for multi-pilot mission planning and flying, focused on inexpensive drones. Split an area into cells, fly, upload and review, then process everything as one task.

## Features

- Draw or import (GeoJSON, KML) the area to map and split it into cells.
- Flight plans for every cell: DJI (KMZ), Litchi (CSV), QGroundControl (.plan), with a live path preview.
- Pilots claim a cell, fly it, upload images and submit it for review.
- Review uploads with thumbnails and photo locations on the map, then approve or request a reflight.
- Process all approved images as a single WebODM task.
- Access uses WebODM projects: add users or groups as pilots or managers, or open a mission to everyone.

## Install

Download the `.zip` from the [releases page](../../releases), then in WebODM go to **Administration** → **Plugins** → **Load Plugin (.zip)**.

## Usage

Open **Crowd Missions** from the menu and press **New mission**: draw the area, pick a cell size and the flight settings, then **Create mission**.

Pilots select a cell on the map, press **Claim this cell**, download the flight plan, fly it and upload the images. Review submitted cells from the **Cell** tab and press **Start processing** from the **Processing** tab when ready.

## Contributing

Feedback is welcome! Open an [issue](../../issues) to report bugs, or suggest features. Pull requests are welcome too.

## License

[AGPLv3](LICENSE)

## Credits

Originally inspired by [drone-tm](https://github.com/hotosm/drone-tm)
