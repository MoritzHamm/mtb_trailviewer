# Data Structure

## Basics

An _adventure_ is a dataset that defines a session of the game. For now, no data is referenced between adventures. It will carry some _metadata_, which is a collection of data used for UI display, a key-value store will do perfectly here, if the list of adventures can be filtered for them (e.g., there could be a field that indicates age rating, and we might filter out those for older age groups).

An adventure has a number of _scenes_. A scene has a locality on the map, not necessarily a point though; it can also be a line or a polygon. The locality means "if the user reaches this locality (or crosses this line, or enters this area), the following unfolds". Scenes maintain two states in general: their activation, which means if the scene will trigger if the player reaches it, and their visibility, which means if they will be shown on the map. Those are orthogonal, a scene can be invisible but active (then the player has to find it by other means, e.g., hints from a previous scene) or it can be visible but inactive (told to the player as a goal in the future of the adventure, so that they can plan for their path towards it). Scenes will also have some metadata for display (if they are visible).

The gameplay logic of a scene will vary between scene types. From simple "reach this location" to "solve this puzzle", "win this fight" etc., this is how the game should scale. Once a scene triggers, players will be presented with the specific gameplay of the scene. This can involve interacting with the app, or doing something in space, like running away from the origin of the scene trigger as fast as possible, or moving towards a goal while keeping the phone still during some "red light" intervals (of course I realize they can cheat by putting it on the floor). 
Scenes can be completed, by solving their gameplay. This will then change the statuses of other scenes, possibly with taking the status of other scenes into account. Solve the riddle of the witch, get the information about the placements of the guardian crystals. Visit them all, and the dragon boss fight will activate. Scenes can also be abandoned, by moving away or quitting the gameplay logic. That should, however, not change much data-wise, just put the UI into a different state. Players should always be able to revisit scenes and give it another go. Adventures, in general, should always remain solvable.

To incentivize solving the scene in a better fashion, players will have a value that starts at a given value at the start of an adventure, and then is increased or decreased by their actions. It's not really live energy, more like "how well will they look afterwards". Running away from the explosion further will remove less of this value, and doing the side quest of the wood nymph will give a nice boost. Once the adventure is completed, they will get rewards in some way, and this will be multiplied by the stat. And because we all know how this usually goes, let's keep it a set of stats. And of course, there should be a persistent set of stats as well, to which adventures add. Coins, reputation, again: a set is probably the better choice.

Of course, there will be more concepts depending on how things evolve. Maybe NPC dialog trees. Maybe settings relating to coop play. But as a start, these are the concepts.

## Scene Types

A scene has a type which configures its gameplay characteristics. The idea here is to keep the scene type focused on one aspect only. Instead of adding a spatial trigger and the logic of what to do when the player triggers it to one scene, they should be split; with the trigger scene activating the gameplay scene on activation. 
Every scene type exports a number of settings that are to be configured by the instance that is put into the adventure. For a spatial trigger, this would be the point to reach and the distance at which it triggers, or a polygon that needs to be entered, or a line that needs to be crossed. For a gameplay scene, this will be the configuration of the game that the player has to solve. As such, a number of different parameter types need to be supported, such as:
- location types: point, line, polygon
- flags and numbers, both integer and float
- strings for user display (we are not considering localization at this point)
- images, image sequences, maybe videos
- specific configuration that corresponds to a dedicated editor (e.g., if we want to have a mini-game with a complex level setup, we would probably need a dedicated level editor for authoring that)
- structs and arrays of the above

A scene type would export the parameter it supports, giving their name, type, description and if/what default value they have. To configure the scene in the adventure, an editor would be assembled for these types. Spatial types require a map, others just an input field, and the specific configuration would require a editor class that is used to author it.

The same is true for scene components. There will be component types, and they will also export their settings.

Finally, a scene or scene component type will have an underlying class that runs the logic during gameplay. Once the scene activates, it will run frequently, and be given a context of what the user does spatially. It will then determine what to render on screen and in the various layers of UI (map screen etc.) as well as what states are changed, including its own. E.g., a trigger scene will just watch the player's position and set itself to completed once the user moves into the trigger. It could have a component that registers a polygon to the map screen and pushes a "go to this location" entry to the quest log. This indicates that using immediate mode for these systems will be beneficial - as long as the request is pushed every frame, we show it, and it will automatically disappear once the scene is completed.

A mini-game will actually render to the screen; an AR scene will request AR mode and configure it. If immediate mode is the right choice here remains to be seen, but we should strive to keep this consistent.

# Game Systems

The game runs as an app on your mobile phone. It basically runs in two main states: adventure-pick mode, in which the player selects an adventure in the vicinity, and adventure-play mode, in which one adventure is active and gameplay happens.

Adventure-play mode will always make a number of screens reachable: 
- a map screen that shows where the player actually is. I want this to be a dedicated render eventually, with panning/zooming being less important, since the area of an adventure should not be too big (at least for now). Instead, it should support the narrative and also give a more "narrative-oriented" view of the surroundings, stressing the features relevant to the story more than giving a full overview of what is there - since we are in control of what matters to the player, replicating the "everything is mapped" approach of OSM is not required.
- a quest log, showing what happened and what open tasks are given to the player.
- stats and inventory screens, plus the usual settings and more generic game screens (coop will be added later)
Scenes will push to these screens, depending on their state. If you are to go to the dense forest, it will show a marker, or the path there, on the map screen and put it as an active task to the quest log. The dragon boss fight on the hilltop will always be shown as a "foreshadowing" marker.

Depending on scene type, a gameplay screen can also be enabled. It will show the mini-game to be completed, or use AR to implement gameplay with that. Maybe we will have a partially covering screen on the map as well, e.g., if the task is just to move somewhere (maybe with a timeout, or with the task to keep the mobile as steady as possible, since it now is a delicate price that you need to deliver).

