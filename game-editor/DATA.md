# Data Structure

## Basics

An _adventure_ is a dataset that defines a session of the game. For now, no data is referenced between adventures. It will carry some _metadata_, which is a collection of data used for UI display, a key-value store will do perfectly here, if the list of adventures can be filtered for them (e.g., there could be a field that indicates age rating, and we might filter out those for older age groups).

Under the hood, adventures are made up from a graph of _scene_ nodes. These nodes have a type, and most of what they are is determined by that type. They can be location-based triggers that wait for the player to reach a given location. They can be the drivers of dialogue, or contain a mini-game. Depending on the type, scenes have different type of configuration data associated. They can also have _components_ that relate to systems other than the gameplay logic: the quest log, map markers etc. Those components are again typed, with type-dependent configuration data.

While playing, each scene has a _state_. All scene nodes can be in an activation state, which starts as "inactive" (except for a chosen starting scene of an adventure), but can become "active" and "completed". Further states like "postponed" (by the player) can be considered as well. Additionally, scenes and their components have their own state depending on their type. 

Scenes are organized in an activation graph which is directed and acyclic; it can be represented by giving a disjunction of activation _conditions_. These are formula using other scene node's state as their input. If the one of the conditions is met, the scene will become active. E.g., a dialog scene might become active (and start showing a dialog) by having a spatial trigger scene become completed (which it does as soon as the player enters it). It might also depend on you having succeeded a side-quest, or having an item in your inventory (which is another concept, discussed below).

Conditions will also be used by scenes and their components. E.g., you will get a quest entry about a future scene if you talk to the right NPC; this would set the state about the NPC and then trigger the activation of the scene's condition. 



## Player State

To incentivize solving the scene in a better fashion, players will have a value that starts at a given value at the start of an adventure, and then is increased or decreased by their actions. It's not really live energy, more like "how well will they look afterwards". Running away from the explosion further will remove less of this value, and doing the side quest of the wood nymph will give a nice boost. Once the adventure is completed, they will get rewards in some way, and this will be multiplied by the stat. And because we all know how this usually goes, let's keep it a set of stats. And of course, there should be a persistent set of stats as well, to which adventures add. Coins, reputation, again: an extensible set is probably the better choice.

## Scene types

A scene is intended to be (at least capable of) gradual reveal. You might not know what awaits you at a certain location, just that it is there, or have partial information. Once you arrive, the actual task is presented. Once completed, further scenes will become available (or the adventure will end). To keep things simple, a scene will only have one task to complete. However, we can use multiple scenes to realize parallel or sequential tasks. 

So, for example, you might be given the hint that the forest on the other side of the stream has had strange visitors, and you should investigate. Once there, you need to actually find some indication via an AR minigame. Once that is completed, the scene technically completes, but a new scene is activated right away and gives you a fight against the creature you just discovered. Once the creature is defeated it will tell you the location of the secret treasure on the hilltop.

Every scene thus has metadata to define what the user sees when the scene is visible, what is presented to the user when the scene _becomes_ visible, and what is presented when the scene becomes activated. Then there is some configuration of what happens when the scene is completed. This might require more complex logic than just graph edges - e.g., the outcome of a previous conversation might dictate which fraction's quest you need to complete next. Also, there needs to be support for more advanced triggers - e.g., the final fight only becomes active if all the guardian stones have been destroyed.